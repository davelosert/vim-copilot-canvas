import { createApiClient } from "./api-client.js";
import { createDocumentController } from "./document-controller.js";
import { createEditor } from "./editor.js";
import { createAgent } from "./agent.js";
import { createExplorer } from "./explorer.js";
import { createCommands } from "./commands.js";
import { createPreview } from "./preview.js";
import { createReview } from "./review.js";
import { createSettings } from "./settings.js";
import { createShell } from "./shell.js";
import { createScrollSync } from "./scroll-sync.js";
import { isMarkdown } from "./markdown.js";

/** Compose one panel. The synchronous handle permits disposal even during startup. */
export function mountApp({ root = document, window: win = root.ownerDocument?.defaultView ?? root.defaultView,
    api = createApiClient({ token: win.location.hash.slice(1), fetch: win.fetch.bind(win) }),
    confirm = win.confirm.bind(win), pollInterval = 2000 } = {}) {
    const doc = root.ownerDocument ?? root;
    const $ = (id) => {
        const element = root.querySelector(`[id="${id}"]`);
        if (!element) throw new Error(`Missing application element: ${id}`);
        return element;
    };
    const elements = (names) => Object.fromEntries(Object.entries(names).map(([key, id]) => [key, $(id)]));
    let disposed = false, interval, controller, shell, review, commands, scrollSync;
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
    const agent = createAgent({
        getPath: () => controller.getState().current.path,
        reviewCount: () => review.count(),
        send: (input) => api("agent", input),
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
        onEdit: () => { preview.edited(); controller.edited(); },
        onSave: save, onCursor: (position) => shell.cursor(position),
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
    };
    const open = async (path, { focusEditor = true } = {}) => {
        let opened = await controller.open(path);
        // Ask only after the queued operation observes the conflict, not from a stale UI snapshot.
        if (!disposed && !opened && controller.getState().blocked &&
            confirm("This panel has unsynced local text that conflicts with another panel. Discard it and switch files?")) {
            opened = await controller.open(path, { discard: true });
        }
        if (!disposed && opened && focusEditor) editor.focus();
        return opened;
    };
    const focusExplorer = () => { shell.setSidebar(true); explorer.focus(); };
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
        onReload: () => {
            if (!confirm("Discard the unsaved draft for this file and reload the disk version? This also affects other panels editing the same draft.")) return;
            editor.setEditable(false);
            safe(controller.reload()).finally(() => editor.setEditable(true));
        },
    });
    const preview = createPreview({
        element: $("preview"), words: $("words"), readText: editor.readText,
        onRender: () => scrollSync?.refresh(),
    });
    review = createReview({
        elements: elements({ bar: "review", count: "review-count", list: "review-list", send: "review-send", discard: "review-discard", toggle: "review-toggle", status: "agent-status" }),
        api, confirm, onError: report,
        onMarkers: (items) => {
            if (disposed || !editor.view) return;
            if (items === null) review.markers(controller.getState().current.path);
            else agent.setMarkers(editor.view, items);
        },
        edit: async (item) => {
            if (await open(item.path) && !disposed && controller.getState().current.path === item.path) agent.edit(editor.view, item);
        },
    });
    const explorer = createExplorer({
        tree: $("tree"), api, onOpen: (path, options) => open(path, options),
        onLeave: () => shell.focusEditor(),
        onHide: () => { shell.setSidebar(false); editor.focus(); }, onError: report,
    });
    const preferences = createSettings({
        elements: elements({ dialog: "settings", button: "settings-button", close: "close-settings", relative: "relative-line-numbers", agentVim: "agent-vim-mode", theme: "editor-theme", status: "settings-status" }),
        api, onSettings: (value) => { editor.applySettings(value); agent.applySettings(value); applyShellTheme(); },
    });
    controller = createDocumentController({
        api: {
            document: (path) => api(path ? `document?path=${encodeURIComponent(path)}` : "document"),
            draft: (input) => api("draft", input), save: (input) => api("save", input),
            open: (input) => api("open", input), reload: (input) => api("reload", input),
        },
        readText: editor.readText, onState: (state) => shell.state(state),
        onPoll: () => review.refresh(),
        onDocument: (snapshot, options) => {
            editor.applyDocument(snapshot, options);
            scrollSync ??= createScrollSync({
                editor: editor.view.scrollDOM, editorContent: editor.view.contentDOM, preview: $("preview"),
            });
            scrollSync.document(isMarkdown(snapshot.name), { reset: options.kind === "switch" });
            commands.attach();
            shell.document(snapshot);
            preview.document(snapshot);
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
    listen($("collapse-tree"), "click", () => explorer.collapseAll());
    const updateTheme = () => {
        if (disposed) return;
        const dark = systemDark();
        editor.updateTheme(dark);
        applyShellTheme();
    };
    updateTheme();
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
            controller.dispose(); commands.dispose(); explorer.dispose(); preferences.dispose();
            review.dispose(); preview.dispose(); shell.dispose();
            scrollSync?.dispose();
            editor.dispose(); agent.dispose();
        },
    };
}
