import { realpath } from "node:fs/promises";
import { diskText } from "./files.mjs";

// Only committed SDK fileEdits are evidence. Tool arguments and shell path hints are not.
export function createAgentHistory({ store, sessionId }) {
    const turns = new Map(), tools = new Map(), interactions = new Map();
    const turnKey = (event) => event.data.turnId && JSON.stringify([event.agentId ?? null, event.data.turnId]);
    const remember = (map, key, value) => {
        map.set(key, value);
        if (map.size > 256) map.delete(map.keys().next().value);
    };
    return {
        async handle(event) {
            const data = event.data;
            if (event.type === "session.context_cleared") { turns.clear(); tools.clear(); interactions.clear(); return; }
            if (event.type === "user.message") {
                const key = turnKey(event);
                if (key && data.messageId) remember(turns, key, [...new Set([...(turns.get(key) ?? []), data.messageId])].slice(-100));
                if (data.interactionId && data.messageId) {
                    const interaction = JSON.stringify([event.agentId ?? null, data.interactionId]);
                    remember(interactions, interaction, [...new Set([...(interactions.get(interaction) ?? []), data.messageId])].slice(-100));
                }
                return;
            }
            if (event.type === "assistant.turn_start") {
                const ids = interactions.get(JSON.stringify([event.agentId ?? null, data.interactionId]));
                const key = turnKey(event);
                if (ids && key) remember(turns, key, [...new Set([...(turns.get(key) ?? []), ...ids])].slice(-100));
                return;
            }
            if (event.type === "tool.execution_start") {
                remember(tools, data.toolCallId, {
                    started: Date.parse(event.timestamp), toolName: data.toolName,
                    messageIds: turns.get(turnKey(event)) ?? tools.get(data.parentToolCallId)?.messageIds ?? [],
                });
                return;
            }
            if (event.type !== "tool.execution_complete") return;
            const start = tools.get(data.toolCallId);
            tools.delete(data.toolCallId);
            const messageIds = turns.get(turnKey(event)) ?? start?.messageIds ?? [];
            for (const edit of data.fileEdits ?? []) {
                if (edit.kind === "delete") continue;
                let path;
                try { path = await realpath(edit.path); }
                catch (error) { if (error.code === "ENOENT") continue; throw error; }
                const document = store.documents.get(path);
                if (!document) continue;
                await store.locked(document, async () => {
                    const disk = await diskText(path);
                    await store.history.observe(path, disk, {
                        sessionId, toolCallId: data.toolCallId, toolName: start?.toolName,
                        turnId: data.turnId, messageIds, started: start?.started ?? Date.parse(event.timestamp),
                    });
                });
            }
        },
    };
}

export function observeAgentHistory(session, store) {
    const tracker = createAgentHistory({ store, sessionId: session.sessionId });
    let pending = Promise.resolve();
    return session.on((event) => {
        if (!["user.message", "assistant.turn_start", "tool.execution_start", "tool.execution_complete", "session.context_cleared"].includes(event.type)) return;
        pending = pending.then(() => tracker.handle(event)).catch((error) => {
            session.log(`Copilot file-write history could not be captured: ${error.message}`, { level: "error" });
        });
    });
}
