import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// GitHub Primer syntax palettes (github-light-default / github-dark-default).
const palettes = {
    light: { comment: "#59636e", keyword: "#cf222e", string: "#0a3069", constant: "#0550ae", entity: "#8250df", tag: "#116329", variable: "#953800", heading: "#0550ae", link: "#0a3069", invalid: "#82071e", inserted: "#116329", deleted: "#82071e" },
    dark: { comment: "#9198a1", keyword: "#ff7b72", string: "#a5d6ff", constant: "#79c0ff", entity: "#d2a8ff", tag: "#7ee787", variable: "#ffa657", heading: "#79c0ff", link: "#a5d6ff", invalid: "#ffa198", inserted: "#7ee787", deleted: "#ffa198" },
};

function highlightStyle(c) {
    return HighlightStyle.define([
        { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c.comment, fontStyle: "italic" },
        { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: c.keyword },
        { tag: [t.string, t.special(t.string), t.regexp, t.character], color: c.string },
        { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.name), t.standard(t.name), t.escape], color: c.constant },
        { tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.typeName, t.namespace, t.macroName], color: c.entity },
        { tag: [t.tagName, t.angleBracket], color: c.tag },
        { tag: [t.attributeName, t.propertyName, t.labelName], color: c.constant },
        { tag: [t.definition(t.variableName), t.self, t.special(t.variableName)], color: c.variable },
        { tag: [t.meta, t.processingInstruction, t.documentMeta], color: c.comment },
        { tag: t.heading, color: c.heading, fontWeight: "bold" },
        { tag: t.strong, fontWeight: "bold" },
        { tag: t.emphasis, fontStyle: "italic" },
        { tag: t.strikethrough, textDecoration: "line-through" },
        { tag: [t.link, t.url], color: c.link, textDecoration: "underline" },
        { tag: t.monospace, color: c.constant },
        { tag: t.quote, color: c.inserted },
        { tag: [t.list, t.contentSeparator], color: c.variable },
        { tag: t.inserted, color: c.inserted },
        { tag: t.deleted, color: c.deleted },
        { tag: t.invalid, color: c.invalid },
    ], { themeType: c === palettes.dark ? "dark" : "light" });
}

const highlights = { light: highlightStyle(palettes.light), dark: highlightStyle(palettes.dark) };

export function editorTheme(dark) {
    return [
        EditorView.theme({
            "&": { color: "var(--editor-text)", backgroundColor: "var(--editor-surface)" },
            ".cm-content": { caretColor: "var(--editor-text)" },
            "&.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--editor-accent) 25%, transparent)", outline: "none" },
            ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, #d4a72c 35%, transparent)" },
        }, { dark }),
        syntaxHighlighting(highlights[dark ? "dark" : "light"]),
    ];
}
