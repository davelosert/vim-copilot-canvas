import { basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { Marked } from "marked";
import markedAlert from "marked-alert";
import markedFootnote from "marked-footnote";
import { gfmHeadingId } from "marked-gfm-heading-id";
import filterXSS from "xss";
import { createExplorer } from "./explorer.js";

const $ = (id) => document.getElementById(id);
const heading = ["id", "class"];
const previewTags = {
    a: ["href", "title", "id", "aria-describedby", "aria-label", "data-footnote-ref", "data-footnote-backref"],
    blockquote: [],
    br: [],
    code: [],
    del: [],
    details: ["open"],
    div: ["class"],
    em: [],
    h1: heading,
    h2: heading,
    h3: heading,
    h4: heading,
    h5: heading,
    h6: heading,
    hr: [],
    input: ["type", "checked", "disabled"],
    kbd: [],
    li: ["id"],
    ol: ["start"],
    p: ["class"],
    pre: [],
    section: ["class", "data-footnotes"],
    strong: [],
    sub: [],
    summary: [],
    sup: [],
    table: [],
    tbody: [],
    td: ["align", "colspan", "rowspan"],
    th: ["align", "colspan", "rowspan"],
    thead: [],
    tr: [],
    ul: [],
};
const previewSanitizer = {
    whiteList: previewTags,
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script", "style", "iframe", "object", "embed", "form", "audio", "video"],
    css: false,
    // Prefixes ids like GitHub ("user-content-") so headings/footnotes cannot clobber DOM globals.
    onTagAttr: (tag, name, value, isWhiteAttr) => isWhiteAttr && name === "id" ? `id="user-content-${filterXSS.escapeAttrValue(value)}"` : undefined,
};
const token = location.hash.slice(1);
const theme = new Compartment();
const lineBreaks = new Compartment();
const editable = new Compartment();
let editor;
let current;
let localVersion = 0;
let persistedVersion = 0;
let applying = false;
let blocked = false;
let saveQueued = false;
let saveFailed = false;
let previewTimer;
let operations = Promise.resolve();
let explorer;

const markdownRenderer = new Marked({ gfm: true, breaks: false })
    .use(gfmHeadingId())
    .use(markedAlert())
    .use(markedFootnote());

async function api(path, input) {
    const response = await fetch(`/api/${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers: { "X-Editor-Token": token, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input), keepalive: false }),
    });
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(result.message);
        error.code = result.error;
        throw error;
    }
    return result;
}

function showError(error) {
    if (localPending() || current?.dirty) saveFailed = true;
    if (error.code === "draft_conflict") blocked = true;
    if (error.code === "disk_conflict" && current) current.conflict = true;
    $("notice-text").textContent = error.message;
    $("notice").hidden = false;
    $("draft-status").textContent = blocked ? "Draft conflict" : "Not synced";
    refreshStatus();
}

function enqueue(operation) {
    const result = operations.catch(() => {}).then(operation);
    operations = result;
    return result;
}

const text = () => editor.state.sliceDoc();
const localPending = () => localVersion !== persistedVersion;

function refreshStatus() {
    if (!current) return;
    const dirty = localPending() || current.dirty;
    $("filename").textContent = `${current.name}${dirty ? " •" : ""}`;
    $("save-status").textContent = blocked ? "Draft conflict" : current.conflict ? "Disk conflict" : saveFailed ? "Not saved" : dirty ? "Saving..." : "Saved to disk";
    $("conflict").hidden = !current.conflict && !blocked;
    $("conflict").querySelector("span").textContent = blocked
        ? "Another panel changed this draft. Your local text is preserved."
        : "The file changed on disk. Your draft is safe; saving is blocked.";
}

function renderPreview() {
    const source = text();
    const clean = filterXSS(markdownRenderer.parse(source), previewSanitizer);
    $("preview").innerHTML = clean;
    for (const link of $("preview").querySelectorAll("a")) {
        const href = link.getAttribute("href") ?? "";
        if (href.startsWith("#")) continue;
        if (/^https?:\/\//i.test(href)) {
            link.target = "_blank";
            link.rel = "noopener noreferrer";
        } else {
            link.removeAttribute("href");
            link.title = "Only web links are opened from preview.";
        }
    }
    const count = source.trim() ? source.trim().split(/\s+/u).length : 0;
    $("words").textContent = `${count.toLocaleString()} word${count === 1 ? "" : "s"}`;
}

function updateCursor() {
    const position = editor.state.selection.main.head;
    const line = editor.state.doc.lineAt(position);
    const column = [...editor.state.sliceDoc(line.from, position)].length + 1;
    $("cursor").textContent = `Ln ${line.number}, Col ${column}`;
}

async function flushDraft({ drain = true } = {}) {
    if (blocked) throw Object.assign(new Error("Resolve the draft conflict before saving. Your local text has not been replaced."), { code: "draft_conflict" });
    while (localPending()) {
        const version = localVersion;
        const content = text();
        $("draft-status").textContent = "Recovering draft...";
        const snapshot = await api("draft", { path: current.path, revision: current.revision, content });
        current = snapshot;
        persistedVersion = version;
        $("draft-status").textContent = localPending() ? "Draft pending" : "Draft recovered";
        refreshStatus();
        if (!drain) break;
    }
}

async function flushChanges() {
    do {
        await flushDraft({ drain: false });
        if (current.dirty) {
            $("draft-status").textContent = "Saving...";
            try {
                current = await api("save", { path: current.path, revision: current.revision });
            } catch (error) {
                await flushDraft();
                throw error;
            }
        }
    } while (localPending());
    saveFailed = false;
    $("draft-status").textContent = "All changes saved";
    $("notice").hidden = true;
    refreshStatus();
}

function scheduleSave() {
    if (saveQueued) return;
    saveQueued = true;
    enqueue(flushChanges).catch(showError).finally(() => { saveQueued = false; });
}

function save() {
    return enqueue(flushChanges).catch(showError);
}

function replaceDocument(snapshot) {
    applying = true;
    try {
        editor.dispatch({
            changes: { from: 0, to: editor.state.doc.length, insert: snapshot.content },
            effects: lineBreaks.reconfigure(EditorState.lineSeparator.of(snapshot.content.includes("\r\n") ? "\r\n" : "\n")),
        });
    } finally {
        applying = false;
    }
    current = snapshot;
    saveFailed = false;
    localVersion = persistedVersion = 0;
    renderPreview();
    updateCursor();
    refreshStatus();
}

function darkMode() {
    const mode = document.documentElement.dataset.colorMode ?? document.body.dataset.colorMode;
    if (mode === "dark" || mode === "light") return mode === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
}

function editorTheme() {
    return EditorView.theme({
        "&": { color: "var(--editor-text)", backgroundColor: "var(--editor-surface)" },
        ".cm-content": { caretColor: "var(--editor-text)" },
    }, { dark: darkMode() });
}

const documentUrl = () => `document?path=${encodeURIComponent(current.path)}`;

function createState(content) {
    return EditorState.create({
            doc: content,
            extensions: [
                vim(), basicSetup, markdown(), EditorView.lineWrapping,
                lineBreaks.of(EditorState.lineSeparator.of(content.includes("\r\n") ? "\r\n" : "\n")),
                theme.of(editorTheme()), editable.of(EditorView.editable.of(true)),
                EditorView.contentAttributes.of({ "aria-label": "Markdown editor", spellcheck: "false" }),
                keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { save(); return true; } }]),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged && !applying) {
                        localVersion++;
                        $("draft-status").textContent = "Draft pending";
                        clearTimeout(previewTimer);
                        previewTimer = setTimeout(renderPreview, 100);
                        scheduleSave();
                        refreshStatus();
                    }
                    if (update.selectionSet || update.docChanged) updateCursor();
                }),
            ],
    });
}

function setMode(mode, subMode) {
    const label = mode === "visual" ? (subMode ? `VISUAL ${subMode}` : "VISUAL") : mode.toUpperCase();
    $("mode").textContent = label.toUpperCase();
    $("mode").dataset.mode = mode.toUpperCase();
}

function attachVim() {
    getCM(editor).on("vim-mode-change", ({ mode, subMode }) => setMode(mode, subMode));
    setMode("normal");
}

function showDocument() {
    $("filepath").textContent = current.path;
    $("filepath").title = current.path;
    document.title = `${current.name} · Vim Markdown`;
    $("draft-status").textContent = current.dirty ? "Draft recovered" : "All changes saved";
    renderPreview();
    updateCursor();
    refreshStatus();
    if (current.dirty && !current.conflict) scheduleSave();
}

function loadDocument(snapshot) {
    current = snapshot;
    saveFailed = false;
    localVersion = persistedVersion = 0;
    editor.setState(createState(snapshot.content));
    attachVim();
    showDocument();
    explorer?.reveal(snapshot.path);
}

// Fresh EditorState per file so undo history and Vim state never leak across documents.
function switchTo(path, { focusEditor = true, fromServer = false } = {}) {
    const run = async () => {
        if (path === current.path) {
            if (focusEditor) editor.focus();
            return;
        }
        if (blocked) {
            if (fromServer || !confirm("This panel has unsynced local text that conflicts with another panel. Discard it and switch files?")) return;
            blocked = false;
        } else {
            await flushDraft();
            if (!current.conflict) await flushChanges();
        }
        loadDocument(await api("open", { path }));
        $("notice").hidden = true;
        if (focusEditor) editor.focus();
    };
    return fromServer ? run() : enqueue(run).catch(showError);
}

function setSidebar(open) {
    $("shell").dataset.sidebar = open ? "open" : "closed";
    $("toggle-explorer").setAttribute("aria-pressed", String(open));
    editor.requestMeasure();
}

const sidebarOpen = () => $("shell").dataset.sidebar === "open";

function focusExplorer() {
    setSidebar(true);
    explorer.focus();
}

// Closing the Vim command prompt refocuses the editor after an ex command returns.
const focusExplorerAfterEx = () => setTimeout(focusExplorer);

function focusEditor() {
    if (matchMedia("(max-width: 700px)").matches) setSidebar(false);
    editor.focus();
}

function registerVimCommands() {
    Vim.defineEx("write", "w", (_cm, params) => {
        if (params.argString?.trim()) {
            showError(new Error(":w only saves the current file. Use :e <path> or the explorer to switch files."));
            return;
        }
        save();
    });
    Vim.defineEx("edit", "e", (_cm, params) => {
        const target = params.argString?.trim();
        if (!target) return;
        switchTo(target);
    });
    Vim.defineEx("Explore", "Ex", focusExplorerAfterEx);
    Vim.defineEx("Lexplore", "Lex", () => (sidebarOpen() ? setSidebar(false) : focusExplorerAfterEx()));
    Vim.defineAction("focusExplorer", () => focusExplorer());
    // The default normal-mode <C-w> "idle" binding is a full match that would swallow <C-w>h.
    Vim.unmap("<C-w>", "normal");
    for (const keys of ["<C-w>h", "<C-w><C-h>", "<C-w>w", "<C-w><C-w>"]) {
        Vim.mapCommand(keys, "action", "focusExplorer", {}, { context: "normal" });
    }
}

function setupSidebar() {
    explorer = createExplorer({
        tree: $("tree"), api,
        onOpen: (path, { focusEditor: focus }) => switchTo(path, { focusEditor: focus }),
        onLeave: focusEditor,
        onHide: () => { setSidebar(false); editor.focus(); },
        onError: showError,
    });
    $("toggle-explorer").addEventListener("click", () => (sidebarOpen() ? setSidebar(false) : focusExplorer()));
    $("refresh-tree").addEventListener("click", () => explorer.refresh());
    $("collapse-tree").addEventListener("click", () => explorer.collapseAll());
    if (matchMedia("(max-width: 700px)").matches) setSidebar(false);
    const handle = $("resize-explorer");
    handle.addEventListener("pointerdown", (event) => {
        handle.setPointerCapture(event.pointerId);
        const move = (moveEvent) => {
            const width = Math.max(160, Math.min(moveEvent.clientX, innerWidth * 0.6));
            $("shell").style.setProperty("--explorer-width", `${width}px`);
            editor.requestMeasure();
        };
        const up = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
    });
    return explorer.init(current.path).then((result) => {
        $("explorer-root").textContent = result.rootName;
        $("explorer-root").title = result.root;
    });
}

async function boot() {
    const initial = await api("document");
    current = initial;
    editor = new EditorView({ state: createState(initial.content), parent: $("editor") });
    attachVim();
    registerVimCommands();
    showDocument();
    editor.focus();
    setupSidebar().catch(showError);

    // In-document links (headings, footnotes) must not replace location.hash, which carries the API token.
    $("preview").addEventListener("click", (event) => {
        const link = event.target.closest?.('a[href^="#"]');
        if (!link) return;
        event.preventDefault();
        let id = link.getAttribute("href").slice(1);
        try { id = decodeURIComponent(id); } catch {}
        const target = id && $("preview").querySelector(`[id="user-content-${CSS.escape(id)}"]`);
        target?.scrollIntoView({ block: "start" });
    });
    document.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            save();
        }
    }, true);
    for (const button of document.querySelectorAll("[data-layout]")) {
        if (button.tagName !== "BUTTON") continue;
        button.addEventListener("click", () => {
            $("workspace").dataset.layout = button.dataset.layout;
            for (const other of document.querySelectorAll("button[data-layout]")) {
                other.setAttribute("aria-pressed", String(other === button));
            }
            if (button.dataset.layout !== "preview") editor.focus();
            editor.requestMeasure();
        });
    }
    $("help-button").addEventListener("click", () => $("help").showModal());
    $("close-help").addEventListener("click", () => { $("help").close(); editor.focus(); });
    $("dismiss-notice").addEventListener("click", () => { $("notice").hidden = true; });
    $("copy-button").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(text());
            $("draft-status").textContent = "Draft copied";
        } catch {
            showError(new Error("Clipboard access was denied. Switch to Edit, select the text, and copy it manually."));
        }
    });
    $("reload-button").addEventListener("click", () => enqueue(async () => {
        if (!confirm("Discard the unsaved draft for this file and reload the disk version? This also affects other panels editing the same draft.")) return;
        editor.dispatch({ effects: editable.reconfigure(EditorView.editable.of(false)) });
        try {
            const latest = await api(documentUrl());
            const snapshot = await api("reload", { path: current.path, revision: latest.revision, diskHash: latest.diskHash });
            blocked = false;
            replaceDocument(snapshot);
            $("notice").hidden = true;
            $("draft-status").textContent = "Disk version loaded";
        } finally {
            editor.dispatch({ effects: editable.reconfigure(EditorView.editable.of(true)) });
        }
    }).catch(showError));

    const updateTheme = () => editor.dispatch({ effects: theme.reconfigure(editorTheme()) });
    const observer = new MutationObserver(updateTheme);
    for (const node of [document.documentElement, document.body]) {
        observer.observe(node, { attributes: true, attributeFilter: ["data-color-mode", "data-dark-theme", "data-light-theme"] });
    }
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateTheme);
    setInterval(() => {
        if (blocked || document.hidden) return;
        enqueue(async () => {
            if (localPending()) await flushChanges();
            const snapshot = await api(documentUrl());
            if (snapshot.activePath && snapshot.activePath !== current.path) {
                await switchTo(snapshot.activePath, { focusEditor: false, fromServer: true });
                return;
            }
            if (snapshot.revision !== current.revision) {
                if (localPending()) throw Object.assign(new Error("The file or draft changed while you were typing. Your local text is preserved; copy it before reloading."), { code: "draft_conflict" });
                replaceDocument(snapshot);
                $("draft-status").textContent = snapshot.dirty ? "Draft recovered" : "All changes saved";
                if (snapshot.dirty && !snapshot.conflict) scheduleSave();
            } else {
                current = snapshot;
                refreshStatus();
            }
        }).catch(showError);
    }, 2000);
    window.addEventListener("beforeunload", (event) => {
        if (localPending() || current.dirty) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && (localPending() || current.dirty)) save();
    });
}

boot().catch(showError);
