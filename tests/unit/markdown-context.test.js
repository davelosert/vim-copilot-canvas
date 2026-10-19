import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { captureContext } from "../../src/frontend/selection-context.js";
import { isMarkdown, renderMarkdown, wordCount } from "../../src/frontend/markdown.js";

describe("pure Markdown rendering", () => {
    it("preserves extensions, prefixes heading/footnote IDs and strips executable markup", () => {
        const html = renderMarkdown('# Heading\n\n- [x] task\n\n> [!NOTE]\n> Note\n\nText[^1]\n\n[^1]: foot\n\n<script>alert(1)</script><style>body{}</style><img src=x onerror=bad><iframe>bad</iframe><a href="javascript:bad" onclick="bad">link</a>');
        expect(html).toContain('id="user-content-heading"');
        expect(html).toContain("data-footnotes");
        expect(html).toContain("markdown-alert-note");
        expect(html).toContain('type="checkbox"');
        expect(html).not.toMatch(/<script|<style|<iframe|<img|onclick|onerror|javascript:bad|alert\(1\)/);
    });
    it("handles supported Markdown names and word counts without a DOM", () => {
        expect(isMarkdown("README.MDOWN")).toBe(true);
        expect(isMarkdown("code.js")).toBe(false);
        expect(wordCount(" \n ")).toBe(0);
        expect(wordCount("one\t two\nthree")).toBe(3);
    });
});

describe("selection context from a real EditorState", () => {
    it("captures the current line with zero-based UTF-16 coordinates when selection is empty", () => {
        const state = EditorState.create({ doc: "first\n😀 world\nlast", selection: { anchor: 8 } });
        expect(captureContext(state, "/work/note.md")).toEqual({
            path: "/work/note.md", label: "note.md:2",
            selections: [{ start: { line: 1, character: 0 }, end: { line: 1, character: 8 }, text: "😀 world" }],
        });
    });
    it("excludes a trailing empty line from the human label but retains exact selection text", () => {
        const state = EditorState.create({ doc: "one\ntwo\nthree", selection: { anchor: 0, head: 8 } });
        const context = captureContext(state, "/work/test.md");
        expect(context.label).toBe("test.md:1-2");
        expect(context.selections[0]).toEqual({ start: { line: 0, character: 0 }, end: { line: 2, character: 0 }, text: "one\ntwo\n" });
    });
    it("freezes a multi-selection snapshot independently of subsequent transactions", () => {
        const state = EditorState.create({
            doc: "one\ntwo\nthree",
            extensions: [EditorState.allowMultipleSelections.of(true)],
            selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 13)]),
        });
        const context = captureContext(state, "test.md");
        state.update({ changes: { from: 0, to: 3, insert: "changed" } });
        expect(context.label).toBe("test.md:1-3");
        expect(context.selections.map((selection) => selection.text)).toEqual(["one", "three"]);
    });
});
