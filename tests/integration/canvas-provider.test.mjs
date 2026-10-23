import { test, expect } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentStore } from "../../src/backend/document-store.mjs";
import { createPanels, createProvider, createVimCanvas, installationPaths, CANVAS_ID } from "../../src/backend/canvas-provider.mjs";

const installation = fileURLToPath(new URL("../..", import.meta.url));

class FakeCanvasError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
const fakeSdk = { createCanvas: (definition) => definition, CanvasError: FakeCanvasError };

async function fixture(onTestFinished) {
    const base = await realpath(await mkdtemp(join(tmpdir(), "vim-canvas-provider-")));
    const project = join(base, "project");
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(join(project, "a.md"), "# A\n");
    await writeFile(join(project, "b.md"), "# B\n");
    const store = new DocumentStore(join(base, "artifacts"), { welcomePath: join(installation, "resources", "welcome.md") });
    const sent = [];
    const panels = createPanels({ store, root: installation, sendMessage: async (message) => { sent.push(message); return "message-1"; } });
    const canvas = createVimCanvas({ ...fakeSdk, store, panels });
    const action = (name) => canvas.actions.find((value) => value.name === name).handler;
    onTestFinished(async () => {
        await panels.closeAll();
        await rm(base, { recursive: true, force: true });
    });
    return { base, project, store, panels, canvas, action, sent };
}

const api = (url, path, init = {}) => {
    const { origin, hash } = new URL(url);
    return fetch(`${origin}${path}`, {
        ...init,
        headers: { "X-Editor-Token": hash.slice(1), "Content-Type": "application/json", ...init.headers },
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
};

test("installation paths keep artifacts and resources under the installation root", () => {
    expect(installationPaths("/install")).toEqual({
        root: "/install", artifacts: join("/install", "artifacts"), welcome: join("/install", "resources", "welcome.md"),
    });
});

test("canvas registration exposes the stable id, schema and actions", ({ onTestFinished }) => {
    return fixture(onTestFinished).then(({ canvas }) => {
        expect(canvas.id).toBe(CANVAS_ID);
        expect(canvas.displayName).toBe("Vim Copilot Canvas");
        expect(canvas.inputSchema.properties).toHaveProperty("filePath");
        expect(canvas.inputSchema.properties).toHaveProperty("rootPath");
        expect(canvas.actions.map(({ name }) => name)).toEqual(["get_document", "save", "open_file", "list_files"]);
        expect(typeof canvas.open).toBe("function");
        expect(typeof canvas.onClose).toBe("function");
    });
});

test("actions require an open panel", async ({ onTestFinished }) => {
    const { action } = await fixture(onTestFinished);
    await expect(action("get_document")({ instanceId: "missing" })).rejects.toMatchObject({ code: "editor_not_open" });
    await expect(action("list_files")({ instanceId: "missing" })).rejects.toBeInstanceOf(FakeCanvasError);
});

test("open, act, reuse, reopen and close a panel", async ({ onTestFinished }) => {
    const { project, panels, canvas, action } = await fixture(onTestFinished);
    const input = { filePath: join(project, "a.md") };
    const opened = await canvas.open({ instanceId: "panel", input });
    expect(opened.title).toBe("Vim · project");
    expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[0-9a-f]{64}$/);

    expect((await canvas.open({ instanceId: "panel", input })).url).toBe(opened.url);
    expect(panels.size).toBe(1);

    const ctx = { instanceId: "panel" };
    expect((await action("get_document")(ctx)).content).toBe("# A\n");
    expect((await action("list_files")({ ...ctx, input: {} })).entries.filter(({ type }) => type === "file").map(({ name }) => name)).toEqual(["a.md", "b.md"]);

    const switched = await action("open_file")({ ...ctx, input: { path: "b.md" } });
    expect(switched.path).toBe(join(project, "b.md"));
    expect((await action("get_document")(ctx)).path).toBe(join(project, "b.md"));
    const http = await api(opened.url, "/api/document");
    expect(http.body).toMatchObject({ path: join(project, "b.md"), activePath: join(project, "b.md") });

    const saved = await action("save")({ ...ctx, input: { revision: switched.revision } });
    expect(saved.dirty).toBe(false);

    const reopened = await canvas.open({ instanceId: "panel", input: { filePath: join(project, "b.md") } });
    expect(reopened.url).not.toBe(opened.url);
    await expect(fetch(new URL(opened.url).origin)).rejects.toThrow();

    await canvas.onClose(ctx);
    expect(panels.size).toBe(0);
    await expect(action("get_document")(ctx)).rejects.toMatchObject({ code: "editor_not_open" });
    await canvas.onClose(ctx);
});

test("panels keep independent active documents over one shared store", async ({ onTestFinished }) => {
    const { project, canvas, action } = await fixture(onTestFinished);
    const input = { filePath: join(project, "a.md") };
    await canvas.open({ instanceId: "one", input });
    await canvas.open({ instanceId: "two", input });
    await action("open_file")({ instanceId: "two", input: { path: "b.md" } });
    expect((await action("get_document")({ instanceId: "one" })).name).toBe("a.md");
    expect((await action("get_document")({ instanceId: "two" })).name).toBe("b.md");
});

test("panels share batch state and updates across file moves and deletions", async ({ onTestFinished }) => {
    const { project, canvas } = await fixture(onTestFinished);
    const input = { filePath: join(project, "a.md") };
    const one = await canvas.open({ instanceId: "one", input });
    const two = await canvas.open({ instanceId: "two", input });
    const post = (url, path, body) => api(url, path, { method: "POST", body: JSON.stringify(body) });
    const add = (path, text) => ({
        path, prompt: "Fix", selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: text.length }, text }],
    });
    const added = await post(one.url, "/api/review/add", add("a.md", "# A"));
    const id = added.body.items[0].id;
    expect((await api(two.url, "/api/review")).body.items).toHaveLength(1);
    expect((await post(one.url, "/api/files/move", { from: "a.md", to: "renamed.md" })).status).toBe(200);
    expect((await api(two.url, "/api/review")).body.items[0].path).toBe(join(project, "renamed.md"));
    expect((await post(two.url, "/api/review/edit", { id, prompt: "Updated" })).status).toBe(200);
    expect((await api(one.url, "/api/review")).body.items[0]).toMatchObject({ path: join(project, "renamed.md"), prompt: "Updated" });
    expect((await post(one.url, "/api/files/delete", { path: "renamed.md" })).status).toBe(200);
    expect((await api(two.url, "/api/review")).body.items).toEqual([]);
    expect((await post(two.url, "/api/review/add", add("b.md", "# B"))).status).toBe(200);
    expect((await api(one.url, "/api/review")).body.items.map(({ path }) => path)).toEqual([join(project, "b.md")]);
});

test("session working directory is used only without explicit input", async ({ onTestFinished }) => {
    const { project, canvas, action } = await fixture(onTestFinished);
    const opened = await canvas.open({ instanceId: "cwd", input: undefined, session: { workingDirectory: project } });
    expect(opened.title).toBe("Vim · project");
    expect((await action("get_document")({ instanceId: "cwd" })).name).toBe("a.md");
});

test("bundled welcome document is copied into artifacts when nothing is targeted", async ({ onTestFinished }) => {
    const { base, canvas, action } = await fixture(onTestFinished);
    const opened = await canvas.open({ instanceId: "welcome", input: {} });
    expect(opened.title).toBe("Vim · artifacts");
    const document = await action("get_document")({ instanceId: "welcome" });
    expect(document.path).toBe(join(base, "artifacts", "welcome.md"));
    expect(document.content).toBe(await readFile(join(installation, "resources", "welcome.md"), "utf8"));
    const tree = await action("list_files")({ instanceId: "welcome" });
    expect(tree.entries.map(({ name }) => name)).not.toContain("drafts");
});

test("agent messages from a panel reach the injected sender in immediate mode", async ({ onTestFinished }) => {
    const { project, canvas, sent } = await fixture(onTestFinished);
    const { url } = await canvas.open({ instanceId: "agent", input: { filePath: join(project, "a.md") } });
    const response = await api(url, "/api/agent", {
        method: "POST",
        body: JSON.stringify({
            path: join(project, "a.md"), prompt: " Explain ",
            selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, text: "# A" }],
        }),
    });
    expect(response).toEqual({ status: 200, body: { messageId: "message-1" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ prompt: "Explain", mode: "immediate" });
    expect(sent[0].attachments[0]).toMatchObject({ type: "selection", displayName: "a.md:1", filePath: join(project, "a.md") });
});

test("createProvider composes installation paths and serves installation assets", async ({ onTestFinished }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vim-canvas-install-")));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    for (const directory of ["public", "resources", "assets/chunks"]) await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, "public", "index.html"), "<p>installed</p>");
    await writeFile(join(root, "resources", "welcome.md"), "# Installed welcome\n");
    const provider = createProvider({ root, sdk: fakeSdk });
    onTestFinished(() => provider.panels.closeAll());
    expect(provider.store.artifacts).toBe(join(root, "artifacts"));
    const { url } = await provider.canvas.open({ instanceId: "p", input: {} });
    expect(await (await fetch(new URL(url).origin + "/")).text()).toBe("<p>installed</p>");
    await expect(readFile(join(root, "artifacts", "welcome.md"), "utf8")).resolves.toBe("# Installed welcome\n");
    expect((await stat(join(root, "artifacts", "drafts"))).isDirectory()).toBe(true);
    const agent = await api(url, "/api/agent", {
        method: "POST",
        body: JSON.stringify({ path: join(root, "artifacts", "welcome.md"), prompt: "x",
            selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, text: "" }] }),
    });

    expect(agent).toMatchObject({ status: 503, body: { error: "agent_unavailable" } });
});

test("dev identity and session persistence stay separate from checkout assets", async ({ onTestFinished }) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "vim-canvas-dev-")));
    const root = join(base, "checkout");
    const artifactsDir = join(base, "session", "vim-canvas-dev");
    await mkdir(join(root, "public"), { recursive: true });
    await mkdir(join(root, "resources"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "public", "index.html"), "<p>worktree</p>");
    await writeFile(join(root, "assets", "editor.js"), "// worktree bundle\n");
    await writeFile(join(root, "resources", "welcome.md"), "# Dev welcome\n");
    const options = { root, artifactsDir, sdk: fakeSdk, canvasId: "vim-markdown-dev", displayName: "Vim Copilot Canvas (Dev)" };
    const providers = [];
    onTestFinished(async () => {
        await Promise.all(providers.map(({ panels }) => panels.closeAll()));
        await rm(base, { recursive: true, force: true });
    });
    const provider = createProvider(options);
    providers.push(provider);
    expect(provider.canvas).toMatchObject({ id: options.canvasId, displayName: options.displayName });
    expect(provider.paths).toEqual({ root, artifacts: artifactsDir, welcome: join(root, "resources", "welcome.md") });
    const { url } = await provider.canvas.open({ instanceId: "dev", input: {} });
    expect(await (await fetch(new URL(url).origin + "/")).text()).toBe("<p>worktree</p>");
    expect(await (await fetch(new URL(url).origin + "/editor.js")).text()).toBe("// worktree bundle\n");
    const document = await provider.store.open();
    expect(document.path).toBe(join(artifactsDir, "welcome.md"));
    expect(document.content).toBe("# Dev welcome\n");
    await provider.store.update(document, "# Unsaved dev\n", document.revision);
    const review = await api(url, "/api/review/add", {
        method: "POST",
        body: JSON.stringify({ path: document.path, prompt: "Revise",
            selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, text: "#" }] }),
    });
    expect(review.status).toBe(200);
    expect((await stat(join(artifactsDir, "reviews"))).isDirectory()).toBe(true);
    await provider.panels.closeAll();

    const reopened = createProvider(options);
    providers.push(reopened);
    const next = await reopened.canvas.open({ instanceId: "reloaded", input: {} });
    expect((await api(next.url, "/api/document")).body.content).toBe("# Unsaved dev\n");
    expect((await api(next.url, "/api/review")).body.items).toHaveLength(1);
    await expect(stat(join(root, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(document.path, "utf8")).resolves.toBe("# Dev welcome\n");

    const isolated = createProvider({ ...options, artifactsDir: join(base, "other-session", "vim-canvas-dev") });
    providers.push(isolated);
    const other = await isolated.canvas.open({ instanceId: "other", input: {} });
    expect((await api(other.url, "/api/document")).body.content).toBe("# Dev welcome\n");
    expect((await api(other.url, "/api/review")).body.items).toEqual([]);
});
