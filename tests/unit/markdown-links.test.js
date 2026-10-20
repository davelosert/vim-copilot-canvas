import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { markdownLinkAt } from "../../src/frontend/markdown-links.js";

function linkAt(source, text, offset = 1) {
    const state = EditorState.create({ doc: source, extensions: markdown({ base: markdownLanguage }) });
    return markdownLinkAt(state, source.indexOf(text) + offset);
}

describe("Markdown web links", () => {
    it.each([
        ["https://example.com/path.", "example", "https://example.com/path"],
        ["<https://example.com/path>", "example", "https://example.com/path"],
        ['[label](https://example.com/a_(b) "title")', "label", "https://example.com/a_(b)"],
        ['[label](<https://example.com/path> "title")', "label", "https://example.com/path"],
        ["[label](https://example.com/a\\(b\\))", "example", "https://example.com/a(b)"],
        ["[label][ID]\n\n[id]: https://example.com/ref", "label", "https://example.com/ref"],
        ["[label][]\n\n[label]: https://example.com/ref", "label", "https://example.com/ref"],
        ["[label]\n\n[label]: https://example.com/ref", "label", "https://example.com/ref"],
        ["[label][multi word]\n\n[Multi   Word]: https://example.com/ref", "label", "https://example.com/ref"],
    ])("resolves %s", (source, text, href) => {
        expect(linkAt(source, text)?.href).toBe(href);
    });

    it.each([
        "`https://example.com/code`",
        "```\nhttps://example.com/code\n```",
        "    https://example.com/code",
        "[label](javascript:alert(1))",
        "[label](data:text/html,hello)",
        "[label](file:///tmp/test)",
        "[label](./local.md)",
        "[label](#heading)",
        "[label](mailto:test@example.com)",
        "[label](https://)",
        "ordinary text",
    ])("does not activate %s", (source) => {
        const state = EditorState.create({ doc: source, extensions: markdown({ base: markdownLanguage }) });
        for (let position = 0; position <= source.length; position++) {
            expect(markdownLinkAt(state, position)).toBeNull();
        }
    });

    it("does not include trailing punctuation or adjacent text in a bare link", () => {
        const source = "See https://example.com/a_(b). Next";
        const link = linkAt(source, "example");
        expect(source.slice(link.from, link.to)).toBe("https://example.com/a_(b)");
        expect(linkAt(source, "Next")).toBeNull();
    });
});
