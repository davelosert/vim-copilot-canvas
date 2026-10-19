import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { editorThemes } from "./themes.js";

const highlightStyle = (colors) => HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: colors.comment, fontStyle: "italic" },
    { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: colors.keyword },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: colors.string },
    { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.name), t.standard(t.name), t.escape], color: colors.constant },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.typeName, t.namespace, t.macroName], color: colors.entity },
    { tag: [t.tagName, t.angleBracket], color: colors.tag },
    { tag: [t.attributeName, t.propertyName, t.labelName], color: colors.constant },
    { tag: [t.definition(t.variableName), t.self, t.special(t.variableName)], color: colors.variable },
    { tag: [t.meta, t.processingInstruction, t.documentMeta], color: colors.comment },
    { tag: t.heading, color: colors.heading, fontWeight: "bold" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.link, t.url], color: colors.link, textDecoration: "underline" },
    { tag: t.monospace, color: colors.constant },
    { tag: t.quote, color: colors.quote },
    { tag: [t.list, t.contentSeparator], color: colors.variable },
    { tag: t.inserted, color: colors.quote },
    { tag: t.deleted, color: colors.invalid },
    { tag: t.invalid, color: colors.invalid },
]);

function systemDarkMode() {
    const mode = document.documentElement.dataset.colorMode ?? document.body.dataset.colorMode;
    if (mode === "dark" || mode === "light") return mode === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(name) {
    const selected = editorThemes[name] ?? editorThemes.system;
    if (selected.followsSystem) return selected[systemDarkMode() ? "dark" : "light"];
    return selected.light ?? selected.dark;
}

export function editorTheme(name = "system") {
    const selected = editorThemes[name] ?? editorThemes.system;
    const dark = Boolean(selected.dark && !selected.light || selected.followsSystem && systemDarkMode());
    const colors = resolveTheme(name);
    return [
        EditorView.theme({
            "&": { color: colors.foreground, backgroundColor: colors.background },
            ".cm-content": { caretColor: colors.foreground },
            ".cm-gutters": { backgroundColor: colors.gutter, color: colors.muted, borderRight: "none" },
            ".cm-activeLineGutter, .cm-activeLine": { backgroundColor: colors.active },
            ".cm-cursor": { borderLeftColor: colors.foreground },
            ".cm-fat-cursor": { backgroundColor: colors.foreground, color: colors.background },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: colors.selection },
            ".cm-panels": { backgroundColor: colors.gutter, color: colors.foreground },
            ".cm-searchMatch": { backgroundColor: colors.selection },
            "&.cm-focused .cm-matchingBracket": { backgroundColor: colors.selection, outline: "none" },
        }, { dark }),
        syntaxHighlighting(highlightStyle(colors)),
    ];
}
