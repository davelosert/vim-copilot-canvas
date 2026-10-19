import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { editorThemes } from "../shared/themes.js";

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

function resolveTheme(name, systemDark) {
    const selected = editorThemes[name] ?? editorThemes.system;
    if (selected.followsSystem) return selected[systemDark ? "dark" : "light"];
    return selected.light ?? selected.dark;
}

function luminance(color) {
    const channels = color.slice(1, 7).match(/../g).map((value) => parseInt(value, 16) / 255);
    const [red, green, blue] = channels.map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first, second) {
    const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}

export function editorThemePalette(name = "system", systemDark = false) {
    const selected = editorThemes[name] ?? editorThemes.system;
    const dark = Boolean(selected.dark && !selected.light || selected.followsSystem && systemDark);
    const colors = resolveTheme(name, systemDark);
    const accent = colors.heading ?? colors.link;
    const accentContrast = contrastRatio(colors.foreground, accent) >= contrastRatio(colors.background, accent)
        ? colors.foreground : colors.background;
    return { colors, dark, accent, accentContrast };
}

export function editorTheme(name = "system", systemDark = false) {
    const { colors, dark } = editorThemePalette(name, systemDark);
    return [
        EditorView.theme({
            "&": { color: colors.foreground, backgroundColor: colors.background, "--editor-cursor-color": colors.foreground, "--editor-cursor-text": colors.background },
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
