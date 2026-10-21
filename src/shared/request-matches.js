import { normalizeText, changedChunks } from "./change-map.js";
import { selectionRange } from "./selection-range.js";

/** Require an exact pre-edit snapshot and a precise change inside the frozen selection. */
export function matchingRequestPrompts({ before, after, path, agent, requests = [] }) {
    if (!agent) return [];
    const original = normalizeText(before);
    const { b, chunks } = changedChunks(before, after);
    const matches = [];
    for (const request of requests) {
        if (request.status !== "sent" || !agent.requestIds?.includes(request.id) ||
            !agent.messageIds?.includes(request.messageId)) continue;
        for (const item of request.items) {
            const snapshot = request.snapshots?.[item.snapshot];
            if (item.path !== path || snapshot?.path !== path || normalizeText(snapshot.content) !== original) continue;
            const positions = new Set();
            for (const attachment of item.attachments) {
                const range = selectionRange(original, attachment);
                if (!range || range.from === range.to) continue;
                const selectionEnd = original[range.to] === "\n" ? range.to + 1 : range.to;
                for (const chunk of chunks) {
                    if (!chunk.precise) continue;
                    for (const change of chunk.changes) {
                        const from = chunk.fromA + change.fromA, to = chunk.fromA + change.toA;
                        if (from < range.from || to > selectionEnd || from >= range.to) continue;
                        const end = chunk.fromB + change.toB, start = chunk.fromB + change.fromB;
                        const deleted = chunk.fromB === chunk.toB;
                        const position = deleted ? Math.min(chunk.fromB, b.length)
                            : b.lineAt(Math.min(end > start ? end - 1 : start, b.length)).to;
                        const side = deleted ? -0.5 : 1;
                        const identity = `${position}:${side}`;
                        if (positions.has(identity)) continue;
                        positions.add(identity);
                        matches.push({ position, side, prompt: item.prompt, label: attachment.displayName ?? item.label ?? item.path });
                    }
                }
            }
        }
    }
    return matches;
}
