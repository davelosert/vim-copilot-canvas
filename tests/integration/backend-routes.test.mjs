import { test, expect } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentStore } from "../../src/backend/document-store.mjs";
import { Workspace } from "../../src/backend/workspace.mjs";
import { ReviewStore } from "../../src/backend/review-store.mjs";
import { MAX_RECENT, RecentStore } from "../../src/backend/recent-store.mjs";
import { SettingsStore } from "../../src/backend/settings-store.mjs";
import { createRoutes } from "../../src/backend/routes.mjs";
import { buildAttachments, createDelivery, validPrompt } from "../../src/backend/agent-delivery.mjs";
import { startServer } from "../../src/backend/server.mjs";

const installation = fileURLToPath(new URL("../..", import.meta.url));
const selection = (text = "One") => ({ start: { line: 0, character: 0 }, end: { line: 0, character: text.length }, text });

async function fixture(onTestFinished, sendMessage) {
    const base = await realpath(await mkdtemp(join(tmpdir(), "vim-backend-routes-")));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const project = join(base, "project");
    await mkdir(project);
    await writeFile(join(project, "a.md"), "One\nTwo\n");
    await writeFile(join(project, "b.md"), "B\n");
    const store = new DocumentStore(join(base, "artifacts"));
    const workspace = new Workspace(project);
    const document = await store.open(join(project, "a.md"));
    const reviews = new ReviewStore(join(base, "artifacts", "reviews"));
    const settings = new SettingsStore(join(base, "settings.json"));
    const routes = createRoutes({ store, workspace, document, reviews, settings, sendMessage });
    return { base, project, store, workspace, document, reviews, settings, routes };
}

test("routes own the per-panel active path for HTTP and SDK callers", async ({ onTestFinished }) => {
    const { project, routes } = await fixture(onTestFinished);
    expect(routes.state.activePath).toBe(join(project, "a.md"));
    expect((await routes.openFile("b.md")).path).toBe(join(project, "b.md"));
    expect((await routes.document).path).toBe(join(project, "b.md"));
    const opened = await routes.post.get("/api/open")({ path: "a.md" });
    expect(opened).toMatchObject({ name: "a.md", activePath: join(project, "a.md") });
    expect((await routes.get.get("/api/document")(new URLSearchParams())).activePath).toBe(join(project, "a.md"));
    const other = await routes.get.get("/api/document")(new URLSearchParams({ path: "b.md" }));
    expect(other).toMatchObject({ name: "b.md", activePath: join(project, "a.md") });
});

test("document mutations validate input and include the active path", async ({ onTestFinished }) => {
    const { project, routes } = await fixture(onTestFinished);
    const draft = routes.post.get("/api/draft");
    await expect(draft(null)).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    await expect(draft({})).rejects.toMatchObject({ code: "invalid_input", message: "A document path is required." });
    await expect(draft({ path: "a.md" })).rejects.toMatchObject({ message: "A document revision is required." });
    await writeFile(join(project, "..", "outside.md"), "x");
    await expect(draft({ path: "../outside.md", revision: "r" })).rejects.toMatchObject({ code: "outside_root" });
    const current = await routes.get.get("/api/document")(new URLSearchParams());
    const updated = await draft({ path: "a.md", content: "Changed\n", revision: current.revision });
    expect(updated).toMatchObject({ content: "Changed\n", dirty: true, activePath: join(project, "a.md") });
    await expect(draft({ path: "a.md", content: "x", revision: current.revision })).rejects.toMatchObject({ code: "draft_conflict" });
    const saved = await routes.post.get("/api/save")({ path: "a.md", revision: updated.revision });
    expect(saved.dirty).toBe(false);
});

test("agent payload validation and attachment labels", () => {
    expect(validPrompt("  hi  ")).toBe("hi");
    expect(() => validPrompt(" ")).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => validPrompt("x".repeat(32001))).toThrow(expect.objectContaining({ status: 400 }));
    const target = { path: "/r/note.md" };
    expect(() => buildAttachments(target, [])).toThrow(expect.objectContaining({ message: "Editor context is required." }));
    expect(() => buildAttachments(target, [{ start: { line: 1, character: 0 }, end: { line: 0, character: 0 }, text: "" }]))
        .toThrow(expect.objectContaining({ message: "The editor selection is invalid." }));
    const [single, multi, trailing] = buildAttachments(target, [
        selection(),
        { start: { line: 0, character: 1 }, end: { line: 2, character: 1 }, text: "x" },
        { start: { line: 0, character: 0 }, end: { line: 2, character: 0 }, text: "y" },
    ]);
    expect(single).toMatchObject({ type: "selection", filePath: "/r/note.md", displayName: "note.md:1" });
    expect(multi.displayName).toBe("note.md:1-3");
    expect(trailing.displayName).toBe("note.md:1-2");
});

test("delivery requires a sender, forces immediate mode and rejects concurrent sends", async () => {
    await expect(createDelivery(undefined)({ prompt: "x" })).rejects.toMatchObject({ code: "agent_unavailable", status: 503 });
    let release;
    const calls = [];
    const deliver = createDelivery((message) => { calls.push(message); return new Promise((resolve) => { release = resolve; }); });
    const first = deliver({ prompt: "x", mode: "enqueue" });
    await expect(deliver({ prompt: "y" })).rejects.toMatchObject({ code: "agent_busy", status: 409 });
    release("id-1");
    await expect(first).resolves.toBe("id-1");
    expect(calls).toEqual([{ prompt: "x", mode: "immediate" }]);
    const failing = createDelivery(async () => { throw new Error("offline"); });
    await expect(failing({ prompt: "x" })).rejects.toThrow("offline");
    await expect(failing({ prompt: "x" })).rejects.toThrow("offline");
});

test("review send removes comments only after delivery succeeds", async ({ onTestFinished }) => {
    let fail = true;
    const sent = [];
    const { project, routes, reviews, workspace } = await fixture(onTestFinished, async (message) => {
        if (fail) throw Object.assign(new Error("send failed"), { code: "send_failed", status: 502 });
        sent.push(message);
        return "m-1";
    });
    const added = await routes.post.get("/api/review/add")({ path: "a.md", prompt: "Fix", selections: [selection()], label: "first" });
    expect(added.items).toMatchObject([{ path: join(project, "a.md"), label: "first", prompt: "Fix", lines: [{ start: 1, end: 1 }] }]);
    const send = routes.post.get("/api/review/send");
    await expect(send({})).rejects.toMatchObject({ code: "send_failed" });
    expect(await reviews.list(workspace.root)).toHaveLength(1);
    fail = false;
    await expect(send({})).resolves.toEqual({ messageId: "m-1", items: [] });
    expect(sent[0].prompt).toContain("1. first (");
    await expect(send({})).rejects.toMatchObject({ code: "review_empty" });
});

test("review edits persist without changing identity or frozen attachments and reject invalid or missing comments", async ({ onTestFinished }) => {
    const messages = [];
    const { routes, reviews, workspace } = await fixture(onTestFinished, async (message) => { messages.push(message); return "edited"; });
    const added = await routes.post.get("/api/review/add")({ path: "a.md", prompt: "Original", selections: [selection()] });
    const original = (await reviews.list(workspace.root))[0];
    const edit = routes.post.get("/api/review/edit");
    await expect(edit({ prompt: "Missing id" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(edit({ id: original.id, prompt: " " })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(edit({ id: original.id, prompt: "x".repeat(32001) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(edit({ id: "missing", prompt: "Changed" })).rejects.toMatchObject({ code: "review_not_found", status: 404 });
    const edited = await edit({ id: original.id, prompt: "  Updated\ncomment  " });
    expect(edited.items).toEqual([{ ...added.items[0], prompt: "Updated\ncomment" }]);
    const restored = new ReviewStore(reviews.directory);
    expect(await restored.list(workspace.root)).toEqual([{ ...original, prompt: "Updated\ncomment" }]);
    await routes.post.get("/api/review/send")({});
    expect(messages[0].prompt).toContain("Updated\n   comment");
    expect(messages[0].attachments).toEqual(original.attachments);
    await expect(edit({ id: original.id, prompt: "Too late" })).rejects.toMatchObject({ code: "review_not_found" });
});

test("sent requests retain the frozen full document locally without adding it to the SDK payload", async ({ onTestFinished }) => {
    const messages = [];
    const { routes, store, document } = await fixture(onTestFinished, async (message) => { messages.push(message); return "frozen"; });
    const input = { path: document.path, prompt: "Revise One", selections: [selection()], context: "One\nTwo\n", deliveryId: "frozen-source" };
    await store.update(document, "Newer live draft\n", document.revision);
    await routes.post.get("/api/agent")(input);
    expect(messages).toEqual([{ prompt: "Revise One", attachments: buildAttachments(document, input.selections), mode: "immediate" }]);
    const request = await store.history.detail(document.path, input.deliveryId);
    expect(request.snapshots).toEqual([{ path: document.path, content: "One\nTwo\n" }]);
    expect(request.items[0].snapshot).toBe(0);
    await routes.post.get("/api/agent")(input);
    expect(messages).toHaveLength(1);
    expect(document.content).toBe("Newer live draft\n");
});

test("batch editing, restart and later document changes preserve each original request context", async ({ onTestFinished }) => {
    const messages = [];
    const f = await fixture(onTestFinished, async (message) => { messages.push(message); return "batch-context"; });
    const add = f.routes.post.get("/api/review/add");
    await add({ path: "a.md", prompt: "First", selections: [selection()], context: "One\nTwo\n" });
    await add({ path: "b.md", prompt: "Second", selections: [selection("B")], context: "B\n" });
    const [first] = await f.reviews.list(f.workspace.root);
    await f.routes.post.get("/api/review/edit")({ id: first.id, prompt: "Edited first" });
    await f.store.update(f.document, "Different source", f.document.revision);
    const restored = new ReviewStore(f.reviews.directory);
    const routes = createRoutes({ ...f, reviews: restored, sendMessage: async (message) => { messages.push(message); return "batch-context"; } });
    await routes.post.get("/api/review/send")({ deliveryId: "batch-source" });
    const request = await f.store.history.detail(f.document.path, "batch-source");
    expect(request.snapshots).toEqual([{ path: f.document.path, content: "One\nTwo\n" }, { path: join(f.project, "b.md"), content: "B\n" }]);
    expect(request.items.map((item) => item.prompt)).toEqual(["Edited first", "Second"]);
    expect(messages[0].attachments.map((item) => item.text)).toEqual(["One", "B"]);
    expect(messages[0]).not.toHaveProperty("context");
    expect(messages[0]).not.toHaveProperty("snapshots");
});

test("invalid captured context is rejected without sending or adding a pending batch comment", async ({ onTestFinished }) => {
    const messages = [];
    const { routes, reviews, workspace } = await fixture(onTestFinished, async (message) => { messages.push(message); return "unexpected"; });
    for (const route of ["/api/agent", "/api/review/add"]) {
        for (const context of [null, 1, "Wrong text", "One" + "x".repeat(2 * 1024 * 1024)]) {
            await expect(routes.post.get(route)({ path: "a.md", prompt: "Revise", selections: [selection()], context }))
                .rejects.toMatchObject({ code: "invalid_input", status: 400 });
        }
    }
    expect(messages).toEqual([]);
    expect(await reviews.list(workspace.root)).toEqual([]);
});

test("change-detail request context obeys the same explorer-root guard as standalone requests", async ({ onTestFinished }) => {
    const { routes, store, document, project } = await fixture(onTestFinished);
    const original = store.history.detail.bind(store.history);
    store.history.detail = async () => ({
        type: "change", before: "One", after: "Two", requests: [{
            items: [{ path: join(project, "..", "outside.md"), prompt: "Private context" }],
        }],
    });
    await expect(routes.get.get("/api/history/entry")(new URLSearchParams({ path: document.path, id: "change" })))
        .rejects.toMatchObject({ code: "outside_root", status: 403 });
    store.history.detail = original;
});

test("pending context storage has a byte limit for additions and edits without losing saved requests", async ({ onTestFinished }) => {
    const { reviews, workspace } = await fixture(onTestFinished);
    const context = "x".repeat(20 * 1024 * 1024 - 5000);
    const [item] = await reviews.add(workspace.root, { context, prompt: "Small" });
    await expect(reviews.add(workspace.root, { context: "x".repeat(6000) })).rejects.toMatchObject({ code: "review_full", status: 413 });
    await expect(reviews.edit(workspace.root, item.id, "x".repeat(6000))).rejects.toMatchObject({ code: "review_full", status: 413 });
    expect((await reviews.list(workspace.root))[0].prompt).toBe("Small");
    expect(await reviews.remove(workspace.root, [item.id])).toEqual([]);
});

test("HTTP transport keeps guards, assets, limits and error codes", async ({ onTestFinished }) => {
    const { store, workspace, document, base } = await fixture(onTestFinished);
    const entry = await startServer({ store, workspace, document, root: installation, settings: new SettingsStore(join(base, "s.json")) });
    onTestFinished(() => entry.close());
    const { origin, hash } = new URL(entry.url);
    const token = hash.slice(1);
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const css = await fetch(`${origin}/editor.css`);
    expect([css.status, css.headers.get("content-type")]).toEqual([200, "text/css; charset=utf-8"]);
    expect((await fetch(`${origin}/index.html`, { headers: { "X-Editor-Token": token } })).status).toBe(404);
    expect((await fetch(`${origin}/public/editor.css`, { headers: { "X-Editor-Token": token } })).status).toBe(404);
    expect((await fetch(`${origin}/api/document`)).status).toBe(403);
    expect(await (await fetch(`${origin}/api/document`, { headers: { "X-Editor-Token": token, Origin: "http://evil.test" } })).json())
        .toMatchObject({ error: "origin_rejected" });
    const headers = { "X-Editor-Token": token };
    expect((await fetch(`${origin}/api/draft`, { headers })).status).toBe(404);
    expect((await fetch(`${origin}/api/document`, { method: "POST", headers })).status).toBe(404);
    expect((await fetch(`${origin}/api/save`, { method: "POST", headers, body: "{}" })).status).toBe(415);
    const json = { ...headers, "Content-Type": "application/json" };
    expect(await (await fetch(`${origin}/api/save`, { method: "POST", headers: json, body: "{" })).json()).toMatchObject({ error: "invalid_json" });
    const big = await fetch(`${origin}/api/draft`, { method: "POST", headers: json, body: "x".repeat(14 * 1024 * 1024 + 1) });
    expect([big.status, (await big.json()).error]).toEqual([413, "body_too_large"]);
    const doc = await fetch(`${origin}/api/document`, { headers });
    expect((await doc.json()).name).toBe("a.md");
    const settings = await fetch(`${origin}/api/settings`, { method: "POST", headers: json, body: JSON.stringify({ theme: "nope" }) });
    expect([settings.status, (await settings.json()).error]).toEqual([400, "invalid_settings"]);
    expect((await entry.openFile("b.md")).name).toBe("b.md");
    expect((await entry.document).name).toBe("b.md");
    expect(entry.state.activePath).toBe(join(workspace.root, "b.md"));
});

test("file search lists workspace files with persisted recents, newest first", async ({ onTestFinished }) => {
    const { base, project, store, workspace, document, reviews, settings } = await fixture(onTestFinished);
    await mkdir(join(project, "docs"));
    await writeFile(join(project, "docs", "c.md"), "C\n");
    const recents = new RecentStore(join(base, "artifacts", "recent"));
    const routes = createRoutes({ store, workspace, document, reviews, recents, settings });
    await routes.initialized;
    const files = routes.get.get("/api/files");
    expect(await files()).toEqual({ root: project, separator: expect.any(String), files: ["a.md", "b.md", "docs/c.md"], truncated: false, recent: ["a.md"] });
    await routes.post.get("/api/open")({ path: "docs/c.md" });
    await routes.openFile("b.md");
    workspace.invalidateFiles();
    expect((await files()).recent).toEqual(["b.md", "docs/c.md", "a.md"]);

    // Another panel (new store instance) sees the same list; deleted files drop out.
    await rm(join(project, "docs"), { recursive: true });
    workspace.invalidateFiles();
    const other = createRoutes({ store, workspace, document, reviews, settings,
        recents: new RecentStore(join(base, "artifacts", "recent")) });
    await other.initialized;
    expect((await other.get.get("/api/files")()).recent).toEqual(["a.md", "b.md"]);
});

test("recent store caps its list and ignores corrupt or foreign files", async ({ onTestFinished }) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "vim-recent-")));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const recents = new RecentStore(join(base, "recent"));
    await Promise.all(Array.from({ length: MAX_RECENT + 5 }, (_, index) => recents.add("/root", `/root/${index}.md`)));
    const items = await recents.list("/root");
    expect(items).toHaveLength(MAX_RECENT);
    expect(items[0]).toBe(`/root/${MAX_RECENT + 4}.md`);
    expect(await recents.list("/other")).toEqual([]);
    await writeFile(recents.file("/root"), "{not json");
    expect(await recents.list("/root")).toEqual([]);
});
