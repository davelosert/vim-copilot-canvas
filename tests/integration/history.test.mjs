import { readFile, writeFile, readdir, mkdir, copyFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { HistoryStore } from "../../src/backend/history-store.mjs";
import { DocumentStore } from "../../src/backend/document-store.mjs";
import { ReviewStore } from "../../src/backend/review-store.mjs";
import { Workspace } from "../../src/backend/workspace.mjs";
import { createRoutes } from "../../src/backend/routes.mjs";
import { documentFixture, tempDir } from "../helpers/fixtures.mjs";

const selection = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, text: "One" };
const payload = (path, id = "delivery-1") => ({
    id, type: "request", prompt: "Change One", items: [{ path, prompt: "Change One",
        attachments: [{ filePath: path, text: "One", selection }] }],
});
const entries = (store, path) => store.history.list(path).then((result) => result.entries);

test("shipped history storage works in native Node without node_modules", async () => {
    const root = await tempDir();
    await mkdir(join(root, "src", "backend"), { recursive: true });
    await mkdir(join(root, "src", "shared"));
    await mkdir(join(root, "assets"));
    const files = ["src/backend/history-store.mjs", "src/backend/files.mjs", "src/backend/errors.mjs", "src/shared/selection-range.js",
        "assets/history-lock.mjs", "assets/history-diff.mjs"];
    for (const file of files) await copyFile(new URL(`../../${file}`, import.meta.url), join(root, file));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const moduleUrl = pathToFileURL(join(root, "src", "backend", "history-store.mjs")).href;
    const script = `import {HistoryStore} from ${JSON.stringify(moduleUrl)};
        const store = new HistoryStore(${JSON.stringify(join(root, "history"))});
        await store.observe("/test.md", "before");
        await store.observe("/test.md", "after");
        if ((await store.list("/test.md")).entries.length !== 1) throw new Error("Missing history");`;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: root });
});

test("history captures grouped manual edits and external changes without recording own saves twice", async () => {
    const f = await documentFixture({ content: "One\n" });
    await f.store.update(f.document, "Two\n", f.document.revision);
    await f.store.save(f.document, f.document.revision);
    await f.store.update(f.document, "Three\n", f.document.revision);
    await f.store.save(f.document, f.document.revision);
    let list = await entries(f.store, f.path);
    expect(list).toHaveLength(1);
    expect(await f.store.history.detail(f.path, list[0].id)).toMatchObject({
        source: "vim", before: "One\n", after: "Three\n",
    });
    await writeFile(f.path, "External\n");
    await Promise.all([f.store.snapshot(f.document), f.store.snapshot(f.document)]);
    list = await entries(f.store, f.path);
    expect(list.map((entry) => entry.source)).toEqual(["external", "vim"]);
    expect(list[0]).not.toHaveProperty("before");
});

test("history survives store restart and records one net change while closed", async () => {
    const f = await documentFixture();
    await writeFile(f.path, "while closed");
    const reopened = new DocumentStore(f.artifacts);
    const document = await reopened.open(f.path);
    await reopened.snapshot(document);
    await reopened.snapshot(document);
    expect(await entries(reopened, f.path)).toHaveLength(1);
    const second = new DocumentStore(f.artifacts);
    await second.open(f.path);
    expect(await entries(second, f.path)).toHaveLength(1);
});

test("a conflicting draft is archived before reloading external text", async () => {
    const f = await documentFixture();
    await f.store.update(f.document, "local draft", f.document.revision);
    await writeFile(f.path, "external draft");
    const state = await f.store.snapshot(f.document);
    expect(state.conflict).toBe(true);
    await f.store.reload(f.document, state.revision, state.diskHash);
    const list = await entries(f.store, f.path);
    const details = await Promise.all(list.map((entry) => f.store.history.detail(f.path, entry.id)));
    expect(details.map((entry) => entry.after)).toEqual(["external draft", "local draft"]);
});

test("consecutive Vim edits extend the latest entry regardless of idle time or duration", async () => {
    const root = await tempDir();
    let time = 100000;
    const history = new HistoryStore(root, { now: () => time });
    await history.observe("/a", "a");
    await history.local("/a", "a", "a", "noop");
    expect((await history.list("/a")).entries).toHaveLength(0);
    await history.local("/a", "a", "b", "1");
    time += 2001;
    await history.local("/a", "b", "c", "2");
    expect((await history.list("/a")).entries).toHaveLength(1);
    for (let index = 0; index < 31; index++) {
        time += 60000;
        await history.local("/a", index ? `text-${index - 1}` : "c", `text-${index}`, `revision-${index}`);
    }
    const list = await history.list("/a");
    expect(list.entries).toHaveLength(1);
    expect(await history.detail("/a", list.entries[0].id)).toMatchObject({ before: "a", after: "text-30" });
    await history.observe("/a", "external");
    await history.local("/a", "external", "next", "next");
    expect((await history.list("/a")).entries.map((event) => event.source)).toEqual(["vim", "external", "vim"]);
});

test("UTF-8 history is bounded by serialized bytes and count, keeping newest entries", async () => {
    const root = await tempDir();
    const history = new HistoryStore(root, { maxBytes: 2000, maxEntries: 3 });
    await history.observe("/a", "start");
    for (let index = 0; index < 10; index++) await history.observe("/a", `${index} ${"é".repeat(100)}`);
    const list = await history.list("/a");
    expect(list.entries.length).toBeGreaterThan(0);
    expect(list.entries.length).toBeLessThanOrEqual(3);
    expect(list.pruned).toBeGreaterThan(0);
    expect(Buffer.byteLength(await readFile(history.file("/a"), "utf8"))).toBeLessThanOrEqual(2000);
    expect((await history.detail("/a", list.entries[0].id)).after).toMatch(/^9 /);
    await expect(history.detail("/a", "../bad")).rejects.toMatchObject({ code: "invalid_input" });
});

test("corrupt history and write failures are explicit and do not replace the document", async () => {
    const f = await documentFixture();
    const spy = vi.spyOn(f.store.history, "write").mockRejectedValueOnce(new Error("history disk full"));
    await expect(f.store.update(f.document, "replacement", f.document.revision)).rejects.toThrow("history disk full");
    expect(f.document.content).toBe("# Original\n");
    spy.mockRestore();
    await writeFile(f.store.history.file(f.path), "{corrupt");
    await expect(f.store.snapshot(f.document)).rejects.toMatchObject({ code: "history_invalid" });
});

test("pending own writes recover without being mislabeled external", async () => {
    const f = await documentFixture();
    await f.store.history.saving(f.path, "own");
    await writeFile(f.path, "own");
    const history = new HistoryStore(join(f.artifacts, "history"));
    await history.observe(f.path, "own");
    expect((await history.list(f.path)).entries).toHaveLength(0);
});

test("a save response does not silently adopt an external edit made while save finishes", async () => {
    const f = await documentFixture();
    await f.store.update(f.document, "own write", f.document.revision);
    const saved = f.store.history.saved.bind(f.store.history);
    vi.spyOn(f.store.history, "saved").mockImplementationOnce(async (...args) => {
        await saved(...args);
        await writeFile(f.path, "intervening external edit");
    });
    const response = await f.store.save(f.document, f.document.revision);
    expect(response).toMatchObject({ content: "own write", conflict: true, dirty: false });
    const next = await f.store.snapshot(f.document);
    expect(next).toMatchObject({ content: "intervening external edit", conflict: false });
    expect(next.revision).not.toBe(response.revision);
    expect((await entries(f.store, f.path)).map((event) => event.source)).toEqual(["external", "vim"]);
});

test("two stores serialize concurrent writes to shared history", async () => {
    const root = await tempDir();
    const a = new HistoryStore(root), b = new HistoryStore(root);
    await a.observe("/a", "base");
    await Promise.all([a.local("/a", "base", "one", "one"), b.local("/a", "base", "two", "two")]);
    expect((await a.list("/a")).entries).toHaveLength(2);
});

test("a batch is stored once, indexed once per file, and survives restart", async () => {
    const root = await tempDir();
    const history = new HistoryStore(root);
    await history.observe("/a", "One"); await history.observe("/b", "One");
    const a = payload("/a");
    const batch = { ...a, type: "batch", items: [...a.items, ...a.items, ...payload("/b").items] };
    await history.prepare(batch);
    await history.delivered(batch.id, "message-1");
    await history.delivered(batch.id, "message-1");
    const reopened = new HistoryStore(root);
    expect((await reopened.list("/a")).entries).toHaveLength(1);
    expect((await reopened.list("/b")).entries).toHaveLength(1);
    expect((await reopened.detail("/b", batch.id)).items).toHaveLength(3);
    expect((await readdir(join(root, "requests")))).toEqual(["delivery-1.json"]);
});

test("request source snapshots deduplicate per file and revision, survive restart and retain retry receipts", async () => {
    const root = await tempDir(), history = new HistoryStore(root, { maxEntries: 1 });
    await history.observe("/a", "One"); await history.observe("/b", "One");
    const item = (path, context) => ({ ...payload(path).items[0], context });
    const batch = { ...payload("/a"), type: "batch", items: [
        item("/a", "One\n"), item("/a", "One\n"), item("/a", "One\nDifferent\n"), item("/b", "One\n"),
    ] };
    await history.prepare(batch);
    await history.delivered(batch.id, "message");
    const reopened = new HistoryStore(root, { maxEntries: 1 });
    const request = await reopened.detail("/a", batch.id);
    expect(request.snapshots).toEqual([
        { path: "/a", content: "One\n" }, { path: "/a", content: "One\nDifferent\n" }, { path: "/b", content: "One\n" },
    ]);
    expect(request.items.map((item) => item.snapshot)).toEqual([0, 0, 1, 2]);
    expect(request.items.every((item) => !("context" in item))).toBe(true);
    expect(await reopened.prepare(batch)).toMatchObject({ status: "sent", messageId: "message" });
    await reopened.observe("/a", "Changed");
    await reopened.observe("/b", "Changed");
    expect(await readdir(join(root, "requests"))).toEqual([]);
    expect(await reopened.prepare(batch)).toMatchObject({ status: "sent", pruned: true });
});

test("invalid source snapshots are rejected before journaling and snapshot bytes count toward retention", async () => {
    const root = await tempDir(), history = new HistoryStore(root, { maxBytes: 2 * 1024 * 1024 + 8192 });
    await history.observe("/a", "One");
    const withContext = (context) => ({ ...payload("/a"), items: [{ ...payload("/a").items[0], context }] });
    await expect(history.prepare(withContext("Two"))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(history.prepare(withContext("One" + " ".repeat(6000)))).rejects.toMatchObject({ code: "history_full" });
    expect(await readdir(join(root, "requests"))).toEqual([]);
    await history.prepare(payload("/a"));
    await history.delivered("delivery-1", "message");
    expect(await history.detail("/a", "delivery-1")).not.toHaveProperty("snapshots");
});

test("corrupt snapshot references and selection positions fail explicitly after restart", async () => {
    const root = await tempDir(), history = new HistoryStore(root);
    await history.observe("/a", "One");
    const request = { ...payload("/a"), items: [{ ...payload("/a").items[0], context: "One\n" }] };
    await history.prepare(request);
    await history.delivered(request.id, "message");
    const stored = JSON.parse(await readFile(history.requestFile(request.id), "utf8"));
    stored.snapshots[0].content = "Other content";
    await writeFile(history.requestFile(request.id), JSON.stringify(stored));
    await expect(new HistoryStore(root).detail("/a", request.id)).rejects.toMatchObject({ code: "history_invalid" });
});

test("request history recovers partial finalization without delivering again", async () => {
    const root = await tempDir();
    const history = new HistoryStore(root);
    await history.observe("/a", "One");
    await history.prepare(payload("/a"));
    const spy = vi.spyOn(history, "finalize").mockRejectedValueOnce(new Error("write failed"));
    await expect(history.delivered("delivery-1", "message-1")).rejects.toThrow("write failed");
    spy.mockRestore();
    const restarted = new HistoryStore(root);
    expect((await restarted.list("/a")).entries).toHaveLength(1);
    expect((await restarted.detail("/a", "delivery-1")).messageId).toBe("message-1");
});

test("ambiguous and failed deliveries do not appear as sent events", async () => {
    const root = await tempDir();
    const history = new HistoryStore(root);
    await history.observe("/a", "One");
    await history.prepare(payload("/a"));
    expect((await history.list("/a")).uncertain).toHaveLength(1);
    await history.failed("delivery-1");
    expect((await history.list("/a")).entries).toHaveLength(0);
    expect((await history.list("/a")).uncertain).toHaveLength(0);
});

test("pruning the last file reference removes the shared batch payload", async () => {
    const root = await tempDir();
    const history = new HistoryStore(root, { maxEntries: 1 });
    await history.observe("/a", "One");
    await history.prepare(payload("/a"));
    await history.delivered("delivery-1", "message-1");
    await history.observe("/a", "Two");
    expect((await history.list("/a")).entries[0].type).toBe("change");
    expect(await readdir(join(root, "requests"))).toEqual([]);
    expect(await history.prepare(payload("/a"))).toMatchObject({ status: "sent", messageId: "message-1", pruned: true });
    await history.delivered("delivery-1", "message-1");
    expect((await history.list("/a")).entries[0].type).toBe("change");
});

test("failed requests release their payloads and a retry claims its ID before delivery", async () => {
    const root = await tempDir();
    const history = new HistoryStore(root);
    await history.observe("/a", "One");
    await history.prepare(payload("/a"));
    await history.failed("delivery-1");
    expect(await readdir(join(root, "requests"))).toEqual([]);
    const [first, second] = await Promise.all([history.prepare(payload("/a")), history.prepare(payload("/a"))]);
    expect(first.fresh).toBe(true);
    expect(second.fresh).toBeUndefined();
});

test("a sent request separates local editing bursts even within the idle window", async () => {
    const root = await tempDir();
    const history = new HistoryStore(root);
    await history.observe("/a", "One");
    await history.local("/a", "One", "Two", "r1");
    await history.prepare(payload("/a"));
    await history.delivered("delivery-1", "message-1");
    await history.local("/a", "Two", "Three", "r2");
    expect((await history.list("/a")).entries.map((event) => event.type)).toEqual(["change", "request", "change"]);
});

test("pending delivery count and bytes are bounded before sending", async () => {
    const root = await tempDir();
    const history = new HistoryStore(root, { maxEntries: 1 });
    await history.observe("/a", "One");
    await history.prepare(payload("/a"));
    await expect(history.prepare(payload("/a", "delivery-2"))).rejects.toMatchObject({ code: "history_full" });
    await expect(history.prepare({ ...payload("/a"), prompt: "Changed" })).rejects.toMatchObject({ code: "delivery_conflict" });
});

test("an observer does not consume a pending own-write marker while disk still has the old content", async () => {
    const f = await documentFixture();
    const observer = new HistoryStore(join(f.artifacts, "history"));
    await f.store.history.saving(f.path, "own");
    await observer.observe(f.path, "# Original\n");
    await writeFile(f.path, "own");
    await observer.observe(f.path, "own");
    expect((await observer.list(f.path)).entries).toHaveLength(0);
});

test("routes record exact successful direct requests and idempotently retry history finalization", async () => {
    const f = await documentFixture({ name: "a.md", content: "One\n" });
    const sendMessage = vi.fn(async () => "message-1");
    const routes = createRoutes({ store: f.store, workspace: new Workspace(f.root), document: f.document,
        reviews: new ReviewStore(join(f.artifacts, "reviews")), sendMessage });
    const send = routes.post.get("/api/agent");
    const input = { path: f.path, selections: [selection], prompt: "Change One", deliveryId: "send-1" };
    const spy = vi.spyOn(f.store.history, "finalize").mockRejectedValueOnce(new Error("full"));
    await expect(send(input)).rejects.toMatchObject({ code: "history_finalize_failed" });
    spy.mockRestore();
    await expect(send(input)).resolves.toMatchObject({ messageId: "message-1" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const list = await routes.get.get("/api/history")(new URLSearchParams({ path: f.path }));
    expect(list.entries).toHaveLength(1);
    expect((await f.store.history.detail(f.path, "send-1")).items[0].attachments[0].text).toBe("One");
    await expect(routes.get.get("/api/history")(new URLSearchParams({ path: "../outside" }))).rejects.toBeDefined();
    await expect(routes.get.get("/api/history/entry")(new URLSearchParams({ path: f.path, id: "missing" })))
        .rejects.toMatchObject({ code: "history_not_found" });
});

test("batch details retain deleted-file context but refuse a narrower workspace boundary", async () => {
    const f = await documentFixture({ name: "a.md" });
    const other = join(f.root, "sub", "b.md");
    await mkdir(join(f.root, "sub"));
    await writeFile(other, "One");
    await f.store.open(other);
    const request = { ...payload(f.path), type: "batch", items: [...payload(f.path).items, ...payload(other).items] };
    await f.store.history.prepare(request);
    await f.store.history.delivered(request.id, "message-1");
    await unlink(other);
    const routes = createRoutes({ store: f.store, workspace: new Workspace(f.root), document: f.document });
    const detail = await routes.get.get("/api/history/entry")(new URLSearchParams({ path: f.path, id: request.id }));
    expect(detail.items[1].attachments[0].text).toBe("One");
    await writeFile(other, "new text");
    const narrow = createRoutes({ store: f.store, workspace: new Workspace(join(f.root, "sub")), document: await f.store.open(other) });
    await expect(narrow.get.get("/api/history/entry")(new URLSearchParams({ path: other, id: request.id })))
        .rejects.toMatchObject({ code: "outside_root", status: 403 });
});
