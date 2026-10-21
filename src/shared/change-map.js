import { diff, Chunk } from "@codemirror/merge";
import { ChangeSet, Text } from "@codemirror/state";

const options = { scanLimit: 1000, timeout: 50 };
export const normalizeText = (text) => text.replace(/\r\n/g, "\n");
export function changesBetween(before, after) {
    return ChangeSet.of(diff(before, after, options).map((part) => ({
        from: part.fromA, to: part.toA, insert: after.slice(part.fromB, part.toB),
    })), before.length);
}
export function changedChunks(before, after) {
    const a = Text.of(normalizeText(before).split("\n")), b = Text.of(normalizeText(after).split("\n"));
    return { a, b, chunks: Chunk.build(a, b, options) };
}

/** Only exact surviving text is a safe historical destination; never guess from old line numbers. */
export function findHistoricalText(text, current) {
    text = normalizeText(text);
    current = normalizeText(current);
    if (!text) return null;
    const position = current.indexOf(text);
    if (position < 0 || current.indexOf(text, position + 1) >= 0) return null;
    return current.slice(0, position).split("\n").length;
}
