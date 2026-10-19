import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { DEFAULT_WELCOME_PATH } from "../../src/backend/document-store.mjs";
import { DocumentStore, documentFixture, welcomePath } from "../helpers/fixtures.mjs";

const fixture = (content) => documentFixture({ content, prefix: "vim-markdown-test-" });

test("bundled welcome document resolves to the installation resources directory", async () => {
    assert.equal(DEFAULT_WELCOME_PATH, welcomePath);
    await access(welcomePath);
});

test("draft recovery survives new stores and save is explicit", async () => {
    const { path, artifacts, store, document } = await fixture();
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

test("external changes block saves and retain draft through restart", async () => {
    const { path, artifacts, store, document } = await fixture();
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

test("clean documents adopt external edits", async () => {
    const { path, store, document } = await fixture();
    const initial = document.revision;
    await writeFile(path, "# External\n");
    const state = await store.snapshot(document);
    assert.equal(state.content, "# External\n");
    assert.equal(state.conflict, false);
    assert.notEqual(state.revision, initial);
});

test("stale panels cannot replace a newer draft", async () => {
    const { store, document } = await fixture();
    const revision = document.revision;
    await store.update(document, "Newer\n", revision);
    await assert.rejects(store.update(document, "Stale\n", revision), { code: "draft_conflict" });
    assert.equal((await store.snapshot(document)).content, "Newer\n");
});

test("simultaneous opens share the same canonical document", async () => {
    const { path, artifacts } = await fixture();
    const store = new DocumentStore(artifacts);
    const [a, b] = await Promise.all([store.open(path), store.open(path)]);
    assert.equal(a, b);
});

test("reload refuses a stale disk hash", async () => {
    const { path, store, document } = await fixture();
    const state = await store.snapshot(document);
    await writeFile(path, "# More recent\n");
    await assert.rejects(store.reload(document, state.revision, state.diskHash), { code: "disk_conflict" });
});

test("UTF-8, CRLF, file modes and literal trailing newlines are retained", async () => {
    const { path, store, document } = await fixture("# Café\r\n\r\nGrüße\r\n");
    await chmod(path, 0o640);
    const content = "# Café\r\n\r\nGrüße, Welt\r\n";
    const draft = await store.update(document, content, document.revision);
    await store.save(document, draft.revision);
    assert.equal(await readFile(path, "utf8"), content);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
});

test("unsupported files and content are rejected explicitly", async () => {
    const { path, store, document, root } = await fixture();
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

test.each(["script.js", "config.yaml", "data.json", "Makefile", "custom.unknown", ".gitignore"])(
    "arbitrary text format %s retains saving, draft recovery and conflict protection", async (name) => {
        const { root, artifacts, store } = await fixture();
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
    },
);
