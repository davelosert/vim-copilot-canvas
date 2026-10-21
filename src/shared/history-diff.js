import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

export function diffSummary(before, after) {
    const a = Text.of(before.replace(/\r\n/g, "\n").split("\n"));
    const b = Text.of(after.replace(/\r\n/g, "\n").split("\n"));
    let added = 0, removed = 0;
    for (const chunk of Chunk.build(a, b, { scanLimit: 1000, timeout: 50 })) {
        if (chunk.toA !== chunk.fromA) removed += a.lineAt(chunk.endA).number - a.lineAt(chunk.fromA).number + 1;
        if (chunk.toB !== chunk.fromB) added += b.lineAt(chunk.endB).number - b.lineAt(chunk.fromB).number + 1;
    }
    return { added, removed };
}
