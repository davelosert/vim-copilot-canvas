import { expect, test } from "vitest";
import { changedChunks, changesBetween, findHistoricalText, normalizeText } from "../../src/shared/change-map.js";
import { Text } from "@codemirror/state";

test("incremental edits map unchanged cursor anchors through independent changes", () => {
    const before = "before\nanchor\nafter\n", after = "new\nbefore\nanchor\nchanged\n";
    const changes = changesBetween(before, after);
    expect(changes.apply(Text.of(before.split("\n"))).toString()).toBe(after);
    expect(changes.mapPos(before.indexOf("anchor"))).toBe(after.indexOf("anchor"));
});

test("CRLF normalization and deleted anchors stay within the document", () => {
    expect(normalizeText("a\r\nb\r\n")).toBe("a\nb\n");
    const changes = changesBetween("before\nanchor\nafter", "after");
    expect(changes.mapPos(8)).toBeLessThanOrEqual(5);
    const { chunks } = changedChunks("a\r\nb\r\n", "a\r\nnew\r\n");
    expect(chunks.length).toBeGreaterThan(0);
});

test("historical jumps require unique surviving text and reject ambiguous or missing ranges", () => {
    expect(findHistoricalText("anchor\r\n", "new\nanchor\nend")).toBe(2);
    expect(findHistoricalText("same", "same\nsame")).toBeNull();
    expect(findHistoricalText("deleted", "new")).toBeNull();
    expect(findHistoricalText("", "new")).toBeNull();
});
