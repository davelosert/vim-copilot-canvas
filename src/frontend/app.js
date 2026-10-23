import { createApiClient } from "./api-client.js";
import { createDocumentController } from "./document-controller.js";
import { createEditor } from "./editor.js";
import { createAgent } from "./agent.js";
import { createExplorer } from "./explorer.js";
import { createOutline } from "./outline.js";
import { createCommands } from "./commands.js";
import { createPreview } from "./preview.js";
import { createReview } from "./review.js";
import { createSettings } from "./settings.js";
import { createShell } from "./shell.js";
import { createScrollSync } from "./scroll-sync.js";
import { isMarkdown } from "./markdown.js";
import { createHistory } from "./history.js";

/** Compose one panel. The synchronous handle permits disposal even during startup. */
export function mountApp({ root = document, window: win = root.ownerDocument?.defaultView ?? root.defaultView,
    api = createApiClient({ token: win.location.hash.slice(1), fetch: win.fetch.bind(win) }),
    confirm = win.confirm.bind(win), pollInterval = 2000, reloadCanvas = () => win.location.reload() } = {}) {
    const doc = root.ownerDocument ?? root;
    const $ = (id) => {
        const element = root.querySelector(`[id="${id}"]`);
        if (!element) throw new Error(`Missing application element: ${id}`);
        return element;
    };
    const elements = (names) => Object.fromEntries(Object.entries(names).map(([key, id]) => [key, $(id)]));
    let disposed = false, interval, controller, shell, review, commands, scrollSync, outline, history;
    let sidebarView = "files";
    const handlers = new AbortController();
    const listen = (element, type, fn) => element.addEventListener(type, fn, { signal: handlers.signal });
    const report = (error) => { if (!disposed) shell.error(error); };
    const safe = (promise) => Promise.resolve(promise).catch(report);
    const darkQuery = win.matchMedia("(prefers-color-scheme: dark)");
    const systemDark = () => {
        const mode = doc.documentElement.dataset.colorMode ?? doc.body.dataset.colorMode;
        return mode === "dark" || mode === "light" ? mode === "dark" : darkQuery.matches;
    };
    const save = () => safe(controller.save());
    const deliveryIds = new Map();
    const recordedApi = async (path, input) => {
        if (path !== "agent" && path !== "review/send") return api(path, input);
        const signature = JSON.stringify([path, input]);
        if (!deliveryIds.has(signature)) {
            const bytes = win.crypto.getRandomValues(new Uint8Array(16));
            deliveryIds.set(signature, Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
        }
        const result = await api(path, { ...input, deliveryId: deliveryIds.get(signature) });
        deliveryIds.delete(signature);
        void history?.refresh();
        return result;
    };
    const agent = createAgent({
        getPath: () => controller.getState().current.path,
        reviewCount: () => review.count(),
        send: (input) => recordedApi("agent", input),
        addToReview: async (input) => review.set(await api("review/add", input)),
        editReview: async (input) => review.set(await api("review/edit", input)),
        removeReview: async (id) => review.set(await api("review/remove", { ids: [id] })),
        sendReview: async (input) => {
            if (input) review.set(await api("review/add", input));
            await review.submit();
        },
        onDone: (kind) => {
            if (!disposed) $("agent-status").textContent = kind === "review" ? `Added to batch (${review.count()})` : kind === "edit" ? "Batch comment updated" : kind === "delete" ? "Batch comment deleted" : kind === "send" ? "Sent to Agent" : "";
        },
        extensions: () => editor.currentTheme(),
    });
    const editor = createEditor({
        parent: $("editor"), extensions: agent.extensions, systemDark: systemDark(),
        onEdit: () => { preview.edited(); outline.edited(); controller.edited(); },
        onSave: save, onCursor: (position) => { shell.cursor(position); outline?.cursor(position); },
        onMode: (mode, subMode) => shell.mode(mode, subMode),
        onLanguage: (name, markdown) => shell.language(name, markdown), onError: report,
    });
    const applyShellTheme = () => {
        const { colors, dark, accent, accentContrast } = editor.themePalette();
        const values = {
            "--editor-accent": accent,
            "--editor-accent-contrast": accentContrast,
            "--editor-surface": colors.gutter,
            "--editor-page": colors.gutter,
            "--editor-canvas": colors.background,
            "--editor-text": colors.foreground,
            "--editor-muted": colors.muted,
            "--editor-border": `color-mix(in srgb, ${colors.muted} 28%, ${colors.gutter})`,
            "--editor-soft": colors.active,
            "--editor-selection": colors.selection,
            "--editor-success": colors.quote,
            "--editor-warning": colors.constant,
            "--editor-danger": colors.invalid,
            "--editor-important": colors.entity,
            "--tree-folder-color": colors.constant,
            "--tree-markdown-color": colors.entity,
        };
        for (const [property, value] of Object.entries(values)) {
            doc.documentElement.style.setProperty(property, value);
        }
        doc.documentElement.dataset.canvasTheme = dark ? "dark" : "light";
        for (const scope of doc.querySelectorAll(".primer-scope")) {
            scope.dataset.colorMode = dark ? "dark" : "light";
        }
        agent.updateTheme();
        history?.theme();
    };
    const open = async (path, { focusEditor = true } = {}) => {
        history?.closeReview();
        let opened = await controller.open(path);
        // Ask only after the queued operation observes the conflict, not from a stale UI snapshot.
        if (!disposed && !opened && controller.getState().blocked &&
            confirm("This panel has unsynced local text that conflicts with another panel. Discard it and switch files?")) {
            opened = await controller.open(path, { discard: true });
        }
        if (!disposed && opened && focusEditor) editor.focus();
        return opened;
    };
    const focusExplorer = () => {
        shell.setSidebar(true);
        ({ files: explorer, outline, history })[sidebarView].focus();
        if (sidebarView === "history") void history.refresh();
    };
    shell = createShell({
        elements: {
            ...elements({
                shell: "shell", workspace: "workspace", toggleExplorer: "toggle-explorer", resize: "resize-explorer",
                help: "help", helpButton: "help-button", closeHelp: "close-help", notice: "notice", noticeText: "notice-text",
                dismissNotice: "dismiss-notice", copy: "copy-button", reload: "reload-button",
                draftStatus: "draft-status", filename: "filename", filepath: "filepath", saveStatus: "save-status",
                conflict: "conflict", cursor: "cursor", mode: "mode", sourceLabel: "source-label", filetype: "filetype",
                layoutControls: "layout-controls", words: "words",
            }),
            layouts: root.querySelectorAll("button[data-layout]"),
        },
        window: win, editor, readText: editor.readText, onExplorer: focusExplorer, onError: report,
        onLayout: (layout) => preview.setVisible(layout !== "edit"),
        onSidebar: (open) => outline?.setVisible(open && sidebarView === "outline"),
        onReload: () => {
            if (!confirm("Discard the unsaved draft for this file and reload the disk version? This also affects other panels editing the same draft.")) return;
            editor.setEditable(false);
            safe(controller.reload()).finally(() => editor.setEditable(true));
        },
    });
    const preview = createPreview({
        element: $("preview"), words: $("words"), readText: editor.readText,
        renderSource: (source) => api("render", { source }),
        loadImage: (path, source) => api("image", { path, source }), onError: report,
        onRender: () => scrollSync?.refresh(),
    });
    review = createReview({
        elements: elements({ bar: "review", count: "review-count", list: "review-list", send: "review-send", discard: "review-discard", toggle: "review-toggle", status: "agent-status" }),
        api: recordedApi, confirm, onError: report,
        onMarkers: (items) => {
            if (disposed || !editor.view) return;
            if (items === null) review.markers(controller.getState().current.path);
            else agent.setMarkers(editor.view, items);
        },
        edit: async (item) => {
            if (await open(item.path) && !disposed && controller.getState().current.path === item.path) agent.edit(editor.view, item);
        },
    });
    const within = (path, parent) => path === parent || path?.startsWith(`${parent}/`) || path?.startsWith(`${parent}\\`);
    const explorer = createExplorer({
        tree: $("tree"), api, onOpen: (path, options) => open(path, options),
        onLeave: () => shell.focusEditor(),
        onHide: () => { shell.setSidebar(false); editor.focus(); }, onError: report,
        confirm, menu: $("tree-menu"),
        prompt: { form: $("tree-prompt"), label: $("tree-prompt-label"), input: $("tree-prompt-input") },
        onChange: async (change) => {
            if (disposed) return;
            const current = controller.getState().current?.path;
            if (change.action === "create" && change.type === "file") await open(change.path);
            else if (change.action === "move") {
                // The server follows the rename; polling adopts the new path without reloading the text.
                if (within(current, change.from)) await controller.poll();
                await review.refresh();
            } else if (change.action === "delete") {
                await review.refresh();
                if (!within(current, change.path)) return;
                controller.markDeleted();
                if (change.fallback) await open(change.fallback, { focusEditor: false });
                else shell.error(new Error(`${current.split(/[\\/]/).pop()} was deleted. Its text remains in this editor until you open another file.`));
            }
        },
    });
    outline = createOutline({
        list: $("outline"), name: $("outline-name"), getDocument: () => editor.view?.state.doc,
        visible: false,
        onJump: (line, { focusEditor }) => {
            shell.revealSource();
            editor.jumpTo(line, { focus: focusEditor });
            if (focusEditor) shell.focusEditor();
        },
        onLeave: () => shell.focusEditor(),
        onHide: () => { shell.setSidebar(false); editor.focus(); },
    });
    history = createHistory({
        list: $("history-list"), detail: $("history-detail"), status: $("history-status"),
        review: elements({ panel: "history-editor", title: "history-review-title", diff: "history-review-diff", close: "history-review-close" }),
        onReview: () => {
            scrollSync?.preserve();
            $("editor").hidden = true;
            shell.revealSource();
            if (win.matchMedia("(max-width: 700px)").matches) {
                shell.setSidebar(false);
                $("history-review-close").focus();
            }
        },
        onCloseReview: () => { scrollSync?.preserve(); $("editor").hidden = false; editor.measure(); },
        api, readText: editor.readText, onError: report, onOpen: (path) => open(path),
        onJump: (line) => { history.closeReview(); shell.revealSource(); editor.jumpTo(line); shell.focusEditor(); },
        onLeave: () => { history.closeReview(); shell.focusEditor(); },
        theme: editor.currentTheme,
        canRevert: (path, expected) => {
            const state = controller.getState();
            return state.current?.path === path && !state.blocked && !state.current.conflict &&
                editor.readText() === expected;
        },
        onRevert: async (path, expected, content) => {
            if (!confirm("Revert the selected historical changes in the current file? This saves automatically and can be undone in the editor.")) return false;
            await controller.save();
            await controller.poll();
            const state = controller.getState();
            if (state.current.path !== path || state.blocked || state.current.conflict || editor.readText() !== expected) {
                throw new Error("The file has changed since this revision. No historical changes were reverted.");
            }
            editor.replaceText(content);
            await controller.save();
            const saved = controller.getState();
            if (saved.current.path !== path || saved.current.conflict || saved.blocked || saved.dirty || editor.readText() !== content) {
                throw new Error("The file changed or could not be saved during the revert. Review the current file and history.");
            }
            return true;
        },
    });
    const sidebarViews = ["files", "outline", "history"];
    const selectSidebar = (view) => {
        sidebarView = view;
        history.activate(view === "history");
        for (const name of sidebarViews) {
            const selected = name === view;
            $(`${name}-tab`).setAttribute("aria-selected", String(selected));
            $(`${name}-tab`).tabIndex = selected ? 0 : -1;
            $(`${name}-panel`).hidden = !selected;
        }
        outline.setVisible(view === "outline" && shell.sidebarOpen());
    };
    for (const view of sidebarViews) {
        const tab = $(`${view}-tab`);
        listen(tab, "click", () => selectSidebar(view));
        listen(tab, "keydown", (event) => {
            const index = sidebarViews.indexOf(view);
            const next = { ArrowLeft: sidebarViews[(index + sidebarViews.length - 1) % sidebarViews.length],
                ArrowRight: sidebarViews[(index + 1) % sidebarViews.length], Home: "files", End: "history" }[event.key];
            if (next) {
                event.preventDefault();
                selectSidebar(next);
                $(`${next}-tab`).focus();
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                focusExplorer();
            }
        });
    }
    const preferences = createSettings({
        elements: elements({ dialog: "settings", button: "settings-button", close: "close-settings", relative: "relative-line-numbers",
            shortcuts: "show-keyboard-shortcut-indicators", theme: "editor-theme", status: "settings-status",
            save: "save-settings", discard: "discard-settings", agentVim: "agent-vim-mode" }),
        api, onSettings: (value, previous) => {
            editor.applySettings(value);
            if (!previous || value.agentVimMode !== previous.agentVimMode) agent.applySettings(value);
            if (!previous || value.showKeyboardShortcutIndicators !== previous.showKeyboardShortcutIndicators) {
                doc.documentElement.dataset.showKeyboardShortcutIndicators = String(value.showKeyboardShortcutIndicators ?? true);
            }
            if (!previous || value.theme !== previous.theme) applyShellTheme();
        },
    });
    controller = createDocumentController({
        api: {
            document: (path) => api(path ? `document?path=${encodeURIComponent(path)}` : "document"),
            draft: (input) => api("draft", input), save: (input) => api("save", input),
            open: (input) => api("open", input), reload: (input) => api("reload", input),
        },
        readText: editor.readText, onState: (state) => shell.state(state),
        onReloading: (value) => editor.setReadOnly(value),
        onRelocate: (snapshot) => {
            editor.rename(snapshot);
            shell.document(snapshot);
            preview.document(snapshot);
            outline.document(snapshot);
            history.document(snapshot);
            safe(review.refresh());
            safe(explorer.reveal(snapshot.path));
        },
        onPoll: async () => { await Promise.all([review.refresh(), history.refresh()]); },
        onDocument: (snapshot, options) => {
            if (options.kind !== "switch") scrollSync?.preserve();
            editor.applyDocument(snapshot, options);
            scrollSync ??= createScrollSync({
                editor: editor.view.scrollDOM, editorContent: editor.view.contentDOM, preview: $("preview"),
            });
            scrollSync.document(isMarkdown(snapshot.name), { reset: options.kind === "switch" });
            commands.attach();
            shell.document(snapshot);
            preview.document(snapshot, { reset: options.kind === "switch" });
            outline.document(snapshot);
            history.document(snapshot);
            review.markers(snapshot.path);
            if (options.kind === "switch") safe(explorer.reveal(snapshot.path));
        },
    });
    commands = createCommands({
        document: doc, editor, agent,
        actions: {
            save, open: (path) => safe(open(path)), onError: report, focusExplorer,
            sidebarOpen: shell.sidebarOpen, hideExplorer: () => shell.setSidebar(false),
            submitReview: () => safe(review.submit()), discardReview: () => safe(review.discard()),
        },
    });
    listen($("refresh-tree"), "click", () => explorer.refresh());
    listen($("new-file"), "click", () => explorer.createFile());
    listen($("new-folder"), "click", () => explorer.createFolder());
    listen($("collapse-tree"), "click", () => explorer.collapseAll());
    const devReload = root.querySelector("#dev-reload-button");
    if (devReload) listen(devReload, "click", () => {
        if (devReload.disabled || !controller.getState().current) return;
        devReload.disabled = true;
        devReload.textContent = "Rebuilding...";
        safe((async () => {
            try {
                await api("dev/reload", {});
                if (disposed) return;
                await controller.flushDraft();
                if (!disposed) reloadCanvas();
            } finally {
                if (!disposed) {
                    devReload.disabled = false;
                    devReload.textContent = "Reload canvas";
                }
            }
        })());
    });
    const updateTheme = () => {
        if (disposed) return;
        if (editor.updateTheme(systemDark())) applyShellTheme();
    };
    applyShellTheme();
    const observer = new win.MutationObserver(updateTheme);
    for (const node of [doc.documentElement, doc.body]) {
        observer.observe(node, { attributes: true, attributeFilter: ["data-color-mode", "data-dark-theme", "data-light-theme"] });
    }
    darkQuery.addEventListener("change", updateTheme);
    listen(win, "beforeunload", (event) => {
        if (controller.getState().dirty) { event.preventDefault(); event.returnValue = ""; }
    });
    listen(doc, "visibilitychange", () => { if (doc.hidden && controller.getState().dirty) save(); });
    const ready = (async () => {
        try {
            const [initial, settings] = await Promise.all([api("document"), api("settings")]);
            if (disposed) return;
            preferences.apply(settings);
            controller.initialize(initial);
            editor.focus();
            safe(explorer.init(initial.path).then((result) => {
                if (!disposed) {
                    $("explorer-root").textContent = result.rootName;
                    $("explorer-root").title = result.root;
                }
            }));
            safe(review.refresh());
            interval = win.setInterval(() => {
                if (!doc.hidden && !disposed) safe(controller.poll());
            }, pollInterval);
        } catch (error) { report(error); throw error; }
    })();
    return {
        ready, controller, editor,
        dispose() {
            if (disposed) return;
            disposed = true;
            win.clearInterval(interval);
            handlers.abort(); observer.disconnect();
            darkQuery.removeEventListener("change", updateTheme);
            controller.dispose(); commands.dispose(); explorer.dispose(); outline.dispose(); history.dispose(); preferences.dispose();
            review.dispose(); preview.dispose(); shell.dispose();
            scrollSync?.dispose();
            editor.dispose(); agent.dispose();
        },
    };
}
