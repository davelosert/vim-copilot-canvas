import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createAgentHistory, observeAgentHistory } from "../../src/backend/agent-history.mjs";
import { HistoryStore } from "../../src/backend/history-store.mjs";
import { documentFixture } from "../helpers/fixtures.mjs";

const event = (type, data, extra = {}) => ({ type, data, timestamp: new Date().toISOString(), ...extra });
const request = async (f, messageId = "message-1", id = "request-1") => {
    await f.store.history.prepare({
        id, type: "request", prompt: "Rewrite the heading", items: [
            { path: f.path, prompt: "Rewrite the heading", attachments: [] },
        ],
    });
    await f.store.history.delivered(id, messageId);
};
const start = (toolCallId = "tool-1", extra = {}) => event("tool.execution_start", {
    toolCallId, toolName: "apply_patch", turnId: "turn-1", ...extra,
});
const complete = (path, extra = {}) => event("tool.execution_complete", {
    toolCallId: "tool-1", turnId: "turn-1", success: true, fileEdits: [{ path, kind: "edit" }], ...extra,
});
const changes = async (f) => (await f.store.history.list(f.path)).entries.filter((entry) => entry.type === "change");

test.each([false, true])("committed fileEdits identify a Copilot write and exact turn request, polling first: %s", async (pollFirst) => {
    const f = await documentFixture();
    await request(f);
    const tracker = createAgentHistory({ store: f.store, sessionId: "session-1" });
    await tracker.handle(event("user.message", { messageId: "message-1", turnId: "turn-1" }));
    await tracker.handle(start());
    await writeFile(f.path, "# Rewritten\n");
    if (pollFirst) await f.store.snapshot(f.document);
    await tracker.handle(complete(f.path));
    const [change] = await changes(f);
    expect(change).toMatchObject({
        source: "external", agent: { sessionId: "session-1", toolCallId: "tool-1",
            messageIds: ["message-1"], requestIds: ["request-1"] },
    });
    expect(await f.store.history.detail(f.path, change.id)).toMatchObject({ before: "# Original\n", after: "# Rewritten\n" });
    const version = (await f.store.history.list(f.path)).version;
    await tracker.handle(complete(f.path));
    expect((await f.store.history.list(f.path)).version).toBe(version);
    const restarted = new HistoryStore(f.store.history.directory);
    expect((await restarted.list(f.path)).entries[0].agent.requestIds).toEqual(["request-1"]);
});

test("newer unrelated prompts do not inherit the preceding canvas request", async () => {
    const f = await documentFixture();
    await request(f);
    const tracker = createAgentHistory({ store: f.store, sessionId: "session" });
    await tracker.handle(event("user.message", { messageId: "message-1", turnId: "turn-1" }));
    await tracker.handle(event("user.message", { messageId: "different-message", turnId: "turn-2" }));
    await tracker.handle(start("tool-1", { turnId: "turn-2" }));
    await writeFile(f.path, "changed by another prompt");
    await tracker.handle(complete(f.path, { turnId: "turn-2" }));
    expect((await changes(f))[0].agent.requestIds).toEqual([]);
});

test("change details include only retained SDK-associated requests and their frozen source", async () => {
    const f = await documentFixture();
    const original = f.document.content;
    await f.store.history.prepare({
        id: "frozen", type: "request", prompt: "Rewrite", items: [{
            path: f.path, prompt: "Rewrite", context: original, attachments: [{
                filePath: f.path, text: original,
                selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
            }],
        }],
    });
    await f.store.history.delivered("frozen", "message-1");
    await request(f, "unrelated", "unrelated");
    const tracker = createAgentHistory({ store: f.store, sessionId: "session" });
    await tracker.handle(event("user.message", { messageId: "message-1", turnId: "turn-1" }));
    await tracker.handle(start());
    await writeFile(f.path, "# Rewritten\n");
    await tracker.handle(complete(f.path));
    const [change] = await changes(f);
    const detail = await f.store.history.detail(f.path, change.id);
    expect(detail.requests.map((request) => request.id)).toEqual(["frozen"]);
    expect(detail.requests[0].snapshots).toEqual([{ path: f.path, content: original }]);
    f.store.history.maxEntries = 1;
    await f.store.history.observe(f.path, "# Rewritten\n");
    const stored = await f.store.history.read(f.path, "");
    await f.store.history.write(stored);
    expect(await f.store.history.detail(f.path, change.id)).not.toHaveProperty("requests");
});

test("missing fileEdits and shell path hints never imply Copilot authorship", async () => {
    const f = await documentFixture();
    await request(f);
    const tracker = createAgentHistory({ store: f.store, sessionId: "session" });
    await tracker.handle(event("user.message", { messageId: "message-1", turnId: "turn-1" }));
    await tracker.handle(start("tool-1", { toolName: "bash", shellToolInfo: { possiblePaths: [f.path], hasWriteFileRedirection: true } }));
    await writeFile(f.path, "unknown writer");
    await tracker.handle(complete(f.path, { fileEdits: undefined }));
    await f.store.snapshot(f.document);
    expect((await changes(f))[0]).not.toHaveProperty("agent");
});

test("message interaction IDs associate exact turns when user.message lacks turnId", async () => {
    const f = await documentFixture();
    await request(f);
    const tracker = createAgentHistory({ store: f.store, sessionId: "session" });
    await tracker.handle(event("user.message", { messageId: "message-1", interactionId: "interaction" }));
    await tracker.handle(event("assistant.turn_start", { turnId: "turn-1", interactionId: "interaction" }));
    await tracker.handle(start());
    await writeFile(f.path, "new text");
    await tracker.handle(complete(f.path));
    expect((await changes(f))[0].agent.requestIds).toEqual(["request-1"]);
});

test("multiple consumed prompts link to the same turn, not an invented single cause", async () => {
    const f = await documentFixture();
    await request(f);
    await request(f, "message-2", "request-2");
    const tracker = createAgentHistory({ store: f.store, sessionId: "session" });
    for (const messageId of ["message-1", "message-2"]) {
        await tracker.handle(event("user.message", { messageId, turnId: "turn-1" }));
    }
    await tracker.handle(start());
    await writeFile(f.path, "combined change");
    await tracker.handle(complete(f.path));
    expect((await changes(f))[0].agent.requestIds).toEqual(["request-1", "request-2"]);
});

test("request finalization races can link a write already observed in the same turn", async () => {
    const f = await documentFixture();
    await f.store.history.prepare({ id: "late-request", type: "batch", prompt: "batch",
        items: [{ path: f.path, prompt: "update", attachments: [] }] });
    const tracker = createAgentHistory({ store: f.store, sessionId: "session" });
    await tracker.handle(event("user.message", { messageId: "message-1", turnId: "turn-1" }));
    await tracker.handle(start());
    await writeFile(f.path, "changed before delivery receipt");
    await tracker.handle(complete(f.path));
    expect((await changes(f))[0].agent.requestIds).toEqual([]);
    await f.store.history.delivered("late-request", "message-1");
    expect((await changes(f))[0].agent.requestIds).toEqual(["late-request"]);
});

test("subagent turn IDs stay isolated; an explicit parent tool link can carry request provenance", async () => {
    const f = await documentFixture();
    await request(f);
    const tracker = createAgentHistory({ store: f.store, sessionId: "session" });
    await tracker.handle(event("user.message", { messageId: "message-1", turnId: "turn-1" }));
    await tracker.handle(start("parent-tool"));
    await tracker.handle({ ...start("tool-1", { parentToolCallId: "parent-tool" }), agentId: "child" });
    await writeFile(f.path, "child edit");
    await tracker.handle({ ...complete(f.path), agentId: "child" });
    expect((await changes(f))[0].agent.requestIds).toEqual(["request-1"]);
});

test("partial failures still report committed edits; untouched and untracked files add no events", async () => {
    const f = await documentFixture();
    const other = join(f.root, "untracked.md");
    await writeFile(other, "untracked");
    const tracker = createAgentHistory({ store: f.store, sessionId: "session" });
    await tracker.handle(start());
    await tracker.handle(complete(f.path));
    expect(await changes(f)).toHaveLength(0);
    await tracker.handle(start("tool-2"));
    await writeFile(f.path, "partially applied");
    await tracker.handle(complete(f.path, { toolCallId: "tool-2", success: false,
        fileEdits: [{ path: f.path, kind: "edit" }, { path: other, kind: "create" }] }));
    expect((await changes(f))[0].agent.toolCallId).toBe("tool-2");
    expect(f.store.documents.has(other)).toBe(false);
});

test("older external snapshots are not relabeled by a later no-op tool", async () => {
    const f = await documentFixture();
    f.store.history.now = () => 1000;
    await writeFile(f.path, "earlier external write");
    await f.store.snapshot(f.document);
    const tracker = createAgentHistory({ store: f.store, sessionId: "session" });
    await tracker.handle(start());
    await tracker.handle(complete(f.path));
    expect((await changes(f))[0]).not.toHaveProperty("agent");
});

test("event observer reports capture errors and keeps observing subsequent tools", async () => {
    const f = await documentFixture();
    let listener;
    const session = { sessionId: "session", on: (fn) => { listener = fn; }, log: vi.fn() };
    observeAgentHistory(session, f.store);
    const observe = vi.spyOn(f.store.history, "observe").mockRejectedValueOnce(new Error("Disk full"));
    listener(start());
    await writeFile(f.path, "one");
    listener(complete(f.path));
    await expect.poll(() => session.log.mock.calls.length).toBe(1);
    expect(session.log.mock.calls[0]).toEqual([expect.stringContaining("Disk full"), { level: "error" }]);
    listener(start("tool-2"));
    listener(complete(f.path, { toolCallId: "tool-2" }));
    await expect.poll(() => observe.mock.calls.length).toBe(2);
    await expect.poll(async () => (await changes(f)).length).toBe(1);
});
