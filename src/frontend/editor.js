import { basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { vim, getCM } from "@replit/codemirror-vim";
import { editorTheme, editorThemePalette } from "./theme.js";
import { isMarkdown } from "./markdown.js";

export function createEditor({ parent, extensions = [], onEdit, onSave, onCursor, onMode, onLanguage, onError, systemDark = false }) {
    const theme = new Compartment(), numbering = new Compartment(), language = new Compartment();
    const lineBreaks = new Compartment(), editable = new Compartment();
    let settings = { relativeLineNumbers: false, theme: "system" };
    let applying = false, disposed = false, languageRequest = 0, isEditable = true;
    let view, modeListener, cm;
    const lineNumberStyle = () => lineNumbers({
        formatNumber: (number, state) => {
            const active = state.doc.lineAt(state.selection.main.head).number;
            return String(settings.relativeLineNumbers && number !== active ? Math.abs(number - active) : number);
        },
    });
    const currentTheme = () => editorTheme(settings.theme, systemDark);
    const cursor = () => {
        const position = view.state.selection.main.head;
        const line = view.state.doc.lineAt(position);
        onCursor?.({ line: line.number, column: [...view.state.sliceDoc(line.from, position)].length + 1 });
    };
    function state(snapshot) {
        return EditorState.create({
            doc: snapshot.content,
            extensions: [
                vim(), basicSetup, numbering.of(lineNumberStyle()),
                EditorState.transactionExtender.of((transaction) => {
                    if (!settings.relativeLineNumbers ||
                        transaction.startState.doc.lineAt(transaction.startState.selection.main.head).number ===
                        transaction.newDoc.lineAt(transaction.newSelection.main.head).number) return null;
                    return { effects: numbering.reconfigure(lineNumberStyle()) };
                }),
                language.of(isMarkdown(snapshot.name) ? markdown({ codeLanguages: languages }) : []),
                EditorView.lineWrapping, extensions,
                lineBreaks.of(EditorState.lineSeparator.of(snapshot.content.includes("\r\n") ? "\r\n" : "\n")),
                theme.of(currentTheme()), editable.of([EditorView.editable.of(isEditable), EditorState.readOnly.of(!isEditable)]),
                EditorView.contentAttributes.of({ "aria-label": "Text editor", spellcheck: "false" }),
                keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { onSave(); return true; } }]),
                EditorView.updateListener.of((update) => {
                    if (disposed) return;
                    if (update.docChanged && !applying) onEdit();
                    if (update.selectionSet || update.docChanged) cursor();
                }),
            ],
        });
    }
    function attachVim() {
        if (cm && modeListener) cm.off("vim-mode-change", modeListener);
        cm = getCM(view);
        modeListener = ({ mode, subMode }) => onMode?.(mode, subMode);
        cm.on("vim-mode-change", modeListener);
        onMode?.("normal");
    }
    async function configureLanguage(snapshot) {
        const request = ++languageRequest;
        const description = LanguageDescription.matchFilename(languages, snapshot.name);
        const name = isMarkdown(snapshot.name) ? "Markdown" : description?.name ?? "Plain text";
        onLanguage?.(name, isMarkdown(snapshot.name));
        if (isMarkdown(snapshot.name) || !description) return;
        try {
            const support = await description.load();
            if (!disposed && request === languageRequest) view.dispatch({ effects: language.reconfigure(support) });
        } catch (error) {
            if (!disposed && request === languageRequest) onError?.(new Error(`Could not load ${name} highlighting: ${error.message}`));
        }
    }
    return {
        get view() { return view; },
        readText: () => view?.state.sliceDoc() ?? "",
        currentTheme,
        themePalette: () => editorThemePalette(settings.theme, systemDark),
        applyDocument(snapshot, { kind }) {
            if (disposed) return;
            applying = true;
            try {
                if (!view) {
                    view = new EditorView({ state: state(snapshot), parent });
                    attachVim();
                } else if (kind === "switch") {
                    view.setState(state(snapshot));
                    attachVim();
                } else {
                    view.dispatch({
                        changes: { from: 0, to: view.state.doc.length, insert: snapshot.content },
                        effects: lineBreaks.reconfigure(EditorState.lineSeparator.of(snapshot.content.includes("\r\n") ? "\r\n" : "\n")),
                    });
                }
            } finally { applying = false; }
            configureLanguage(snapshot);
            cursor();
        },
        applySettings(value) {
            settings = { ...value };
            if (view && !disposed) view.dispatch({ effects: [numbering.reconfigure(lineNumberStyle()), theme.reconfigure(currentTheme())] });
        },
        updateTheme(dark) {
            systemDark = dark;
            if (view && !disposed) view.dispatch({ effects: theme.reconfigure(currentTheme()) });
        },
        setEditable(value) {
            isEditable = value;
            if (view && !disposed) view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(value), EditorState.readOnly.of(!value)]) });
        },
        focus() { if (!disposed) view?.focus(); },
        measure() { if (!disposed) view?.requestMeasure(); },
        jumpTo(line) {
            if (disposed || !view) return;
            const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
            view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
            view.focus();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            languageRequest++;
            if (cm && modeListener) cm.off("vim-mode-change", modeListener);
            view?.destroy();
        },
    };
}
