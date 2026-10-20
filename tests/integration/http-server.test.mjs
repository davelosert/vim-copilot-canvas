import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { ReviewStore } from "../../src/backend/review-store.mjs";
import { DocumentStore, Workspace, apiClient, documentFixture, startEditorServer, workspaceTree } from "../helpers/fixtures.mjs";

const fixture = (content) => documentFixture({ content, prefix: "vim-markdown-test-" });

test("HTTP endpoints require token and same origin; assets are local", async () => {
    const { root, store, document } = await fixture();
    const workspace = await Workspace.create({ filePath: document.path, ignore: ["artifacts"] });
    const entry = await startEditorServer({ store, workspace, document, settingsRoot: root });
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
    assert.match(asset.headers.get("content-security-policy"), /img-src data:;/);
    const primer = await fetch(new URL("/primer.css", url));
    assert.equal(primer.status, 200);
    assert.match(primer.headers.get("content-type"), /^text\/css/);
    assert.match(await primer.text(), /\.btn-primary/);
    const invalid = await fetch(new URL("/api/draft", url), {
        method: "POST",
        headers: { "X-Editor-Token": token, "Content-Type": "application/json" },
        body: "{",
    });
    assert.equal(invalid.status, 400);
});

// Agent endpoint: originally one sequential scenario; each phase now owns its server and session stub.
const agentInput = (document) => ({
    path: document.path, prompt: " Explain this ",
    selections: [{ start: { line: 0, character: 2 }, end: { line: 0, character: 7 }, text: "Draft" }],
});

async function agentFixture() {
    const { root, store, document } = await fixture();
    const workspace = await Workspace.create({ filePath: document.path, ignore: ["artifacts"] });
    const session = { messages: [], failure: undefined, hold: undefined };
    const entry = await startEditorServer({
        store, workspace, document, settingsRoot: root,
        sendMessage: async (message) => {
            if (session.hold) await session.hold;
            if (session.failure) throw session.failure;
            session.messages.push(message);
            return "message-1";
        },
    });
    const { call } = apiClient(entry);
    const input = agentInput(document);
    const post = (body = input, headers = {}) => call("agent", body, headers);
    return { store, document, workspace, session, input, post };
}

test("Agent endpoint rejects unauthenticated, cross-origin and invalid requests", async () => {
    const { workspace, session, input, post } = await agentFixture();
    assert.equal((await post(input, { "X-Editor-Token": "" })).status, 403);
    assert.equal((await post(input, { Origin: "https://example.com" })).status, 403);
    for (const invalid of [
        { prompt: "" }, { prompt: "x".repeat(32001) }, { selections: [] },
        { selections: [null] },
        { selections: [{ start: { line: -1, character: 0 }, end: { line: 0, character: 0 }, text: "" }] },
        { selections: [{ start: { line: 1, character: 3 }, end: { line: 1, character: 2 }, text: "" }] },
        { path: join(workspace.root, "..", "outside.md") },
    ]) {
        assert.notEqual((await post({ ...input, ...invalid })).status, 200);
    }
    assert.equal(session.messages.length, 0);
});

test("Agent endpoint sends the trimmed prompt and draft selection to the owning session without saving", async () => {
    const { store, document, session, input, post } = await agentFixture();
    await store.update(document, "# Draft\n", document.revision);
    const response = await post();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { messageId: "message-1" });
    assert.deepEqual(session.messages, [{
        prompt: "Explain this", mode: "immediate",
        attachments: [{
            type: "selection", filePath: document.path, displayName: "note.md:1",
            selection: { start: input.selections[0].start, end: input.selections[0].end }, text: "Draft",
        }],
    }]);
    assert.equal(await readFile(document.path, "utf8"), "# Original\n");
});

test("Agent endpoint surfaces session failures and recovers afterwards", async () => {
    const { session, post } = await agentFixture();
    session.failure = new Error("Session disconnected");
    const failed = await post();
    assert.equal(failed.status, 500);
    assert.match((await failed.json()).message, /Session disconnected/);
    session.failure = undefined;
    assert.equal((await post()).status, 200);
});

test("Agent endpoint rejects concurrent deliveries while one is in flight", async () => {
    const { session, post } = await agentFixture();
    let release;
    session.hold = new Promise((resolve) => { release = resolve; });
    const pending = post();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await post()).status, 409);
    release();
    assert.equal((await pending).status, 200);
    session.hold = undefined;
    assert.equal((await post()).status, 200);
});

test("Agent endpoint reports unavailable sessions explicitly", async () => {
    const { root, store, document } = await fixture();
    const workspace = await Workspace.create({ filePath: document.path });
    const entry = await startEditorServer({ store, workspace, document, settingsRoot: root });
    const response = await apiClient(entry).call("agent", {
        path: document.path, prompt: "x", selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, text: "" }],
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "agent_unavailable");
});

// Review endpoints: originally one sequential scenario; each phase starts from its own review state.
async function reviewFixture() {
    const { root: base, store, document, artifacts } = await fixture("One\nTwo\nThree\n");
    const other = join(base, "other.md");
    await writeFile(other, "Other\n");
    const workspace = await Workspace.create({ rootPath: base, ignore: ["artifacts"] });
    const session = { messages: [], failure: undefined };
    const start = (options = {}) => startEditorServer({
        store, workspace, document, settingsRoot: base,
        sendMessage: async (message) => {
            if (session.failure) throw session.failure;
            session.messages.push(message);
            return "review-1";
        },
        ...options,
    });
    const entry = await start();
    const { call } = apiClient(entry);
    const first = { path: document.path, prompt: " Fix wording ", selections: [{ start: { line: 1, character: 0 }, end: { line: 2, character: 5 }, text: "Two\nThree" }] };
    const second = { path: other, prompt: "Shorten", selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 5 }, text: "Other" }] };
    return { base, artifacts, store, document, other, workspace, session, entry, start, call, first, second };
}

test("review endpoints authenticate, validate and collect comments across files", async () => {
    const { base, document, other, session, entry, call, first, second } = await reviewFixture();
    assert.equal((await fetch(new URL("/api/review", entry.url))).status, 403);
    assert.deepEqual(await (await call("review")).json(), { items: [] });
    assert.equal((await call("review/send", {})).status, 400);
    assert.equal((await call("review/add", { ...first, prompt: "" })).status, 400);
    assert.notEqual((await call("review/add", { ...first, path: join(base, "..", "x.md") })).status, 200);
    await call("review/add", first);
    const added = await (await call("review/add", second)).json();
    assert.deepEqual(added.items.map(({ label, prompt, lines, path }) => ({ label, prompt, lines, path })), [
        { label: "note.md:2-3", prompt: "Fix wording", lines: [{ start: 2, end: 3 }], path: document.path },
        { label: "other.md:1", prompt: "Shorten", lines: [{ start: 1, end: 1 }], path: await realpath(other) },
    ]);
    assert.equal(session.messages.length, 0);
});

test("review comments persist for a new server and review store", async () => {
    const { artifacts, start, call, first, second } = await reviewFixture();
    await call("review/add", first);
    await call("review/add", second);
    const reopened = await start({ reviews: new ReviewStore(join(artifacts, "reviews")) });
    assert.equal((await (await apiClient(reopened).call("review")).json()).items.length, 2);
});

test("failed review sends retain comments; successful sends compose one message and clear them", async () => {
    const { session, call, first, second } = await reviewFixture();
    await call("review/add", first);
    await call("review/add", second);
    session.failure = new Error("Session disconnected");
    assert.equal((await call("review/send", {})).status, 500);
    assert.equal((await (await call("review")).json()).items.length, 2);
    session.failure = undefined;
    const sent = await (await call("review/send", {})).json();
    assert.deepEqual(sent, { messageId: "review-1", items: [] });
    const { messages } = session;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].mode, "immediate");
    assert.match(messages[0].prompt, /2 batched requests/);
    assert.match(messages[0].prompt, /1\. note\.md:2-3 \(.*note\.md\)\n   Fix wording/);
    assert.match(messages[0].prompt, /2\. other\.md:1 \(.*other\.md\)\n   Shorten/);
    assert.deepEqual(messages[0].attachments.map(({ displayName, text }) => ({ displayName, text })), [
        { displayName: "note.md:2-3", text: "Two\nThree" }, { displayName: "other.md:1", text: "Other" },
    ]);
});

test("review comments can be removed individually or cleared", async () => {
    const { call, first, second } = await reviewFixture();
    const items = (await (await call("review/add", first)).json()).items;
    await call("review/add", second);
    assert.equal((await call("review/remove", { ids: "x" })).status, 400);
    assert.deepEqual((await (await call("review/remove", { ids: [items[0].id] })).json()).items.map((item) => item.label), ["other.md:1"]);
    assert.deepEqual(await (await call("review/clear", {})).json(), { items: [] });
});

// Tree/open endpoints: the direct Workspace assertions live in workspace.test.mjs.
async function treeServer() {
    const { base, rootDir, workspace } = await workspaceTree();
    const store = new DocumentStore(join(base, "artifacts"));
    const document = await store.open(join(rootDir, "README.md"));
    const entry = await startEditorServer({ store, workspace, document, settingsRoot: base });
    return { base, rootDir, ...apiClient(entry) };
}

test("tree and open endpoints stay inside the workspace root", async () => {
    const { base, call } = await treeServer();
    const tree = await (await call("tree?dir=deep")).json();
    assert.deepEqual(tree.entries.map((e) => e.name), ["deeper", "child.md"]);
    assert.equal((await call(`tree?dir=${encodeURIComponent(base)}`)).status, 403);
    assert.equal((await call("open", { path: join(base, "outside.md") })).status, 403);
    assert.equal((await call("draft", { path: join(base, "outside.md"), revision: 0, content: "x" })).status, 403);
});

test("open changes the panel's active document; drafts and explicit document reads use paths", async () => {
    const { base, rootDir, call } = await treeServer();
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
});

test("opening arbitrary text succeeds but binary files keep the active document", async () => {
    const { rootDir, call } = await treeServer();
    const script = await (await call("open", { path: "script.js" })).json();
    assert.equal(script.content, "x");
    assert.equal(script.activePath, join(rootDir, "script.js"));
    await writeFile(join(rootDir, "binary.bin"), Buffer.from([0, 1, 2]));
    assert.equal((await call("open", { path: "binary.bin" })).status, 400);
    assert.equal((await (await call("document")).json()).path, script.path);
});
