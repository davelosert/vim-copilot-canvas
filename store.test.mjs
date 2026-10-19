import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentStore } from "./store.mjs";
import { startServer } from "./server.mjs";
import { Workspace, resolveInitialTarget } from "./workspace.mjs";
import { realpath, symlink, mkdir } from "node:fs/promises";

async function fixture(t, content = "# Original\n") {
    const root = await mkdtemp(join(tmpdir(), "vim-markdown-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "note.md");
    await writeFile(path, content);
    const artifacts = join(root, "artifacts");
    const store = new DocumentStore(artifacts);
    const document = await store.open(path);
    return { root, path, artifacts, store, document };
}

test("draft recovery survives new stores and save is explicit", async (t) => {
    const { path, artifacts, store, document } = await fixture(t);
    const initial = await store.snapshot(document);
    const edited = await store.update(document, "# Draft\n", initial.revision);
    assert.equal(edited.dirty, true);
    assert.equal(await readFile(path, "utf8"), "# Original\n");
    const reopened = new DocumentStore(artifacts);
    const recovered = await reopened.open(path);
    assert.equal((await reopened.snapshot(recovered)).content, "# Draft\n");
    await reopened.save(recovered, edited.revision);
    assert.equal(await readFile(path, "utf8"), "# Draft\n");
    assert.equal((await reopened.snapshot(recovered)).dirty, false);
});

test("external changes block saves and retain draft through restart", async (t) => {
    const { path, artifacts, store, document } = await fixture(t);
    const draft = await store.update(document, "My changes\n", document.revision);
    await writeFile(path, "Someone else's changes\n");
    await assert.rejects(store.save(document, draft.revision), { code: "disk_conflict" });
    assert.equal(await readFile(path, "utf8"), "Someone else's changes\n");
    const reopened = new DocumentStore(artifacts);
    const recovered = await reopened.open(path);
    const state = await reopened.snapshot(recovered);
    assert.equal(state.content, "My changes\n");
    assert.equal(state.conflict, true);
    const reloaded = await reopened.reload(recovered, state.revision, state.diskHash);
    assert.equal(reloaded.content, "Someone else's changes\n");
    assert.equal(reloaded.dirty, false);
});

test("clean documents adopt external edits", async (t) => {
    const { path, store, document } = await fixture(t);
    const initial = document.revision;
    await writeFile(path, "# External\n");
    const state = await store.snapshot(document);
    assert.equal(state.content, "# External\n");
    assert.equal(state.conflict, false);
    assert.notEqual(state.revision, initial);
});

test("stale panels cannot replace a newer draft", async (t) => {
    const { store, document } = await fixture(t);
    const revision = document.revision;
    await store.update(document, "Newer\n", revision);
    await assert.rejects(store.update(document, "Stale\n", revision), { code: "draft_conflict" });
    assert.equal((await store.snapshot(document)).content, "Newer\n");
});

test("simultaneous opens share the same canonical document", async (t) => {
    const { path, artifacts } = await fixture(t);
    const store = new DocumentStore(artifacts);
    const [a, b] = await Promise.all([store.open(path), store.open(path)]);
    assert.equal(a, b);
});

test("reload refuses a stale disk hash", async (t) => {
    const { path, store, document } = await fixture(t);
    const state = await store.snapshot(document);
    await writeFile(path, "# More recent\n");
    await assert.rejects(store.reload(document, state.revision, state.diskHash), { code: "disk_conflict" });
});

test("UTF-8, CRLF, file modes and literal trailing newlines are retained", async (t) => {
    const { path, store, document } = await fixture(t, "# Café\r\n\r\nGrüße\r\n");
    await chmod(path, 0o640);
    const content = "# Café\r\n\r\nGrüße, Welt\r\n";
    const draft = await store.update(document, content, document.revision);
    await store.save(document, draft.revision);
    assert.equal(await readFile(path, "utf8"), content);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
});

test("unsupported files and content are rejected explicitly", async (t) => {
    const { path, store, document, root } = await fixture(t);
    await assert.rejects(store.open("relative.md"), { code: "absolute_path_required" });
    const other = join(root, "image.png");
    await writeFile(other, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await assert.rejects(store.open(other), { code: "unsupported_encoding" });
    await writeFile(other, Buffer.from([0x61, 0, 0x62]));
    await assert.rejects(store.open(other), { code: "unsupported_file" });
    await writeFile(other, "a".repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(store.open(other), { code: "unsupported_file" });
    await assert.rejects(store.open(root), { code: "unsupported_file" });
    await assert.rejects(store.update(document, "a".repeat(2 * 1024 * 1024 + 1), document.revision), { code: "invalid_content" });
    await writeFile(path, Buffer.from([0xff, 0xfe, 0x61]));
    await assert.rejects(store.snapshot(document), { code: "unsupported_encoding" });
});

test("arbitrary text formats retain saving, draft recovery and conflict protection", async (t) => {
    const { root, artifacts, store } = await fixture(t);
    for (const name of ["script.js", "config.yaml", "data.json", "Makefile", "custom.unknown", ".gitignore"]) {
        const path = join(root, name);
        await writeFile(path, "original\r\n");
        const document = await store.open(path);
        const draft = await store.update(document, "edited\r\n", document.revision);
        const reopened = new DocumentStore(artifacts);
        const recovered = await reopened.open(path);
        assert.equal((await reopened.snapshot(recovered)).content, "edited\r\n");
        await reopened.save(recovered, draft.revision);
        assert.equal(await readFile(path, "utf8"), "edited\r\n");
        const next = await reopened.update(recovered, "local\r\n", recovered.revision);
        await writeFile(path, "external\r\n");
        await assert.rejects(reopened.save(recovered, next.revision), { code: "disk_conflict" });
        assert.equal(await readFile(path, "utf8"), "external\r\n");
    }
});

test("HTTP endpoints require token and same origin; assets are local", async (t) => {
    const { store, document } = await fixture(t);
    const root = dirname(fileURLToPath(import.meta.url));
    const workspace = await Workspace.create({ filePath: document.path, ignore: ["artifacts"] });
    const entry = await startServer({ store, workspace, document, root });
    t.after(() => entry.close());
    const url = new URL(entry.url);
    const token = url.hash.slice(1);
    const api = new URL("/api/document", url);
    assert.equal((await fetch(api)).status, 403);
    assert.equal((await fetch(api, { headers: { "X-Editor-Token": token, Origin: "https://example.com" } })).status, 403);
    const response = await fetch(api, { headers: { "X-Editor-Token": token } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content, "# Original\n");
    const asset = await fetch(new URL("/editor.js", url));
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-security-policy"), /img-src 'none'/);
    const invalid = await fetch(new URL("/api/draft", url), {
        method: "POST",
        headers: { "X-Editor-Token": token, "Content-Type": "application/json" },
        body: "{",
    });
    assert.equal(invalid.status, 400);
});

test("workspace and tree/open endpoints stay inside the root", async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "vim-markdown-ws-")));
    t.after(() => rm(base, { recursive: true, force: true }));
    const rootDir = join(base, "notes");
    await mkdir(join(rootDir, "deep", "deeper"), { recursive: true });
    await mkdir(join(rootDir, "node_modules"), { recursive: true });
    await writeFile(join(rootDir, "README.md"), "# Root\n");
    await writeFile(join(rootDir, "b10.md"), "b10");
    await writeFile(join(rootDir, "b2.md"), "b2");
    await writeFile(join(rootDir, "script.js"), "x");
    await writeFile(join(rootDir, ".hidden.md"), "x");
    await writeFile(join(rootDir, "deep", "child.md"), "# Child\n");
    await writeFile(join(base, "outside.md"), "secret");
    await symlink(join(base, "outside.md"), join(rootDir, "escape.md"));
    const workspace = await Workspace.create({ rootPath: rootDir });
    const listing = await workspace.list();
    assert.deepEqual(listing.entries.map((e) => e.name), ["deep", "node_modules", ".hidden.md", "b2.md", "b10.md", "README.md", "script.js"]);
    assert.equal(await workspace.firstDocument(), join(rootDir, "README.md"));
    await assert.rejects(workspace.resolve(join(base, "outside.md")), { code: "outside_root" });
    await assert.rejects(workspace.resolve("../outside.md"), { code: "outside_root" });
    await assert.rejects(workspace.resolve("escape.md"), { code: "outside_root" });
    assert.equal(await workspace.resolve("deep/child.md"), join(rootDir, "deep", "child.md"));

    const store = new DocumentStore(join(base, "artifacts"));
    const document = await store.open(join(rootDir, "README.md"));
    const entry = await startServer({ store, workspace, document, root: dirname(fileURLToPath(import.meta.url)) });
    t.after(() => entry.close());
    const url = new URL(entry.url);
    const headers = { "X-Editor-Token": url.hash.slice(1), "Content-Type": "application/json" };
    const call = (path, body) => fetch(new URL(`/api/${path}`, url), body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers });
    const tree = await (await call("tree?dir=deep")).json();
    assert.deepEqual(tree.entries.map((e) => e.name), ["deeper", "child.md"]);
    assert.equal((await call(`tree?dir=${encodeURIComponent(base)}`)).status, 403);
    assert.equal((await call("open", { path: join(base, "outside.md") })).status, 403);
    const opened = await (await call("open", { path: "deep/child.md" })).json();
    assert.equal(opened.content, "# Child\n");
    assert.equal(opened.activePath, join(rootDir, "deep", "child.md"));
    const active = await (await call("document")).json();
    assert.equal(active.path, join(rootDir, "deep", "child.md"));
    const draft = await (await call("draft", { path: active.path, revision: active.revision, content: "# Edited\n" })).json();
    assert.equal(draft.dirty, true);
    assert.equal((await call("draft", { path: join(base, "outside.md"), revision: 0, content: "x" })).status, 403);
    const readme = await (await call(`document?path=${encodeURIComponent(join(rootDir, "README.md"))}`)).json();
    assert.equal(readme.content, "# Root\n");
    const script = await (await call("open", { path: "script.js" })).json();
    assert.equal(script.content, "x");
    assert.equal(script.activePath, join(rootDir, "script.js"));
    await writeFile(join(rootDir, "binary.bin"), Buffer.from([0, 1, 2]));
    assert.equal((await call("open", { path: "binary.bin" })).status, 400);
    assert.equal((await (await call("document")).json()).path, script.path);
});

test("initial selection skips binary, oversized and non-UTF-8 files", async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vim-markdown-formats-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "a.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "b.bin"), Buffer.from([0xff, 0xfe]));
    await writeFile(join(root, "c.log"), "a".repeat(2 * 1024 * 1024 + 1));
    assert.equal(await resolveInitialTarget({ workingDirectory: root }), null);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.py"), "print('hello')\n");
    assert.equal((await resolveInitialTarget({ workingDirectory: root })).path, join(root, "src", "main.py"));
    await writeFile(join(root, "Makefile"), "all:\n\techo hello\n");
    assert.equal((await resolveInitialTarget({ workingDirectory: root })).path, join(root, "Makefile"));
    await writeFile(join(root, "README.md"), "# Hello\n");
    assert.equal((await resolveInitialTarget({ workingDirectory: root })).path, join(root, "README.md"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", ".env"), "A=1\n");
    await writeFile(join(root, "nested", "app.ts"), "export {};\n");
    assert.equal(await (await Workspace.create({ rootPath: join(root, "nested") })).firstDocument(), join(root, "nested", "app.ts"));
});

test("initial target defaults to the session working directory", async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "vim-markdown-cwd-")));
    t.after(() => rm(base, { recursive: true, force: true }));
    const project = join(base, "project");
    await mkdir(join(project, "docs"), { recursive: true });
    await writeFile(join(project, "docs", "guide.md"), "# Guide\n");
    const fromCwd = await resolveInitialTarget({ workingDirectory: project });
    assert.equal(fromCwd.workspace.root, project);
    assert.equal(fromCwd.path, join(project, "docs", "guide.md"));
    await writeFile(join(project, "README.md"), "# Readme\n");
    assert.equal((await resolveInitialTarget({ workingDirectory: project })).path, join(project, "README.md"));

    const explicit = await resolveInitialTarget({ rootPath: join(project, "docs"), workingDirectory: project });
    assert.equal(explicit.workspace.root, join(project, "docs"));

    const empty = join(base, "empty");
    await mkdir(empty);
    assert.equal(await resolveInitialTarget({ workingDirectory: empty }), null);
    assert.equal(await resolveInitialTarget({ workingDirectory: join(base, "missing") }), null);
    assert.equal(await resolveInitialTarget({ workingDirectory: "relative" }), null);
    assert.equal(await resolveInitialTarget({}), null);
});
