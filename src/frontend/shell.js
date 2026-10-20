import { isMarkdown } from "./markdown.js";

/** DOM-only presentation and shell interactions. Document persistence lives elsewhere. */
export function createShell({ elements: e, window, editor, readText, onReload, onExplorer, onError }) {
    const handlers = new AbortController();
    const listen = (element, type, fn) => element.addEventListener(type, fn, { signal: handlers.signal });
    let markdownLayout = "split", markdown = false, disposed = false;
    const layout = () => {
        const selected = markdown ? markdownLayout : "edit";
        e.workspace.dataset.layout = selected;
        for (const button of e.layouts) button.setAttribute("aria-pressed", String(button.dataset.layout === selected));
        editor.measure();
    };
    const setSidebar = (open) => {
        e.shell.dataset.sidebar = open ? "open" : "closed";
        e.toggleExplorer.setAttribute("aria-pressed", String(open));
        editor.measure();
    };
    const sidebarOpen = () => e.shell.dataset.sidebar === "open";
    for (const button of e.layouts) listen(button, "click", () => {
        if (!markdown) return;
        markdownLayout = button.dataset.layout;
        layout();
        if (markdownLayout !== "preview") editor.focus();
    });
    listen(e.toggleExplorer, "click", () => sidebarOpen() ? setSidebar(false) : onExplorer());
    listen(e.helpButton, "click", () => e.help.showModal());
    listen(e.closeHelp, "click", () => { e.help.close(); editor.focus(); });
    listen(e.dismissNotice, "click", () => { e.notice.hidden = true; });
    listen(e.copy, "click", async () => {
        try {
            await window.navigator.clipboard.writeText(readText());
            if (!disposed) e.draftStatus.textContent = "Draft copied";
        } catch {
            if (!disposed) onError(new Error("Clipboard access was denied. Switch to Edit, select the text, and copy it manually."));
        }
    });
    listen(e.reload, "click", onReload);
    let drag;
    const stopDrag = () => {
        if (!drag) return;
        e.resize.removeEventListener("pointermove", drag);
        e.resize.removeEventListener("pointerup", stopDrag);
        e.resize.removeEventListener("pointercancel", stopDrag);
        drag = null;
    };
    listen(e.resize, "pointerdown", (event) => {
        stopDrag();
        e.resize.setPointerCapture(event.pointerId);
        drag = (move) => {
            const width = Math.max(160, Math.min(move.clientX, window.innerWidth * 0.6));
            e.shell.style.setProperty("--explorer-width", `${width}px`);
            editor.measure();
        };
        e.resize.addEventListener("pointermove", drag);
        e.resize.addEventListener("pointerup", stopDrag);
        e.resize.addEventListener("pointercancel", stopDrag);
    });
    if (window.matchMedia("(max-width: 700px)").matches) setSidebar(false);
    return {
        setSidebar, sidebarOpen,
        revealSource() {
            if (markdown && markdownLayout === "preview") { markdownLayout = "split"; layout(); }
        },
        focusEditor() { if (window.matchMedia("(max-width: 700px)").matches) setSidebar(false); editor.focus(); },
        language(name, enabled) {
            markdown = enabled;
            e.sourceLabel.textContent = name.toUpperCase(); e.filetype.textContent = name;
            e.layoutControls.hidden = e.words.hidden = !enabled;
            layout();
        },
        document(snapshot) {
            markdown = isMarkdown(snapshot.name);
            e.filepath.textContent = e.filepath.title = snapshot.path;
            e.shell.ownerDocument.title = `${snapshot.name} · Vim Copilot Canvas`;
            layout();
        },
        state(state) {
            if (disposed || !state.current) return;
            const { current, blocked, saveFailed } = state;
            if (e.filename.textContent !== current.name) e.filename.textContent = current.name;
            const saveError = blocked ? "Draft conflict" : current.conflict ? "Disk conflict" : saveFailed ? "Not saved" : "";
            if (e.saveStatus.textContent !== saveError) e.saveStatus.textContent = saveError;
            e.saveStatus.hidden = !saveError;
            e.conflict.hidden = !current.conflict && !blocked;
            e.conflict.querySelector("span").textContent = blocked
                ? "Another panel changed this draft. Your local text is preserved."
                : "The file changed on disk. Your draft is safe; saving is blocked.";
            if (state.error) this.error(state.error);
            else e.notice.hidden = true;
        },
        error(error) { if (!disposed) { e.noticeText.textContent = error.message; e.notice.hidden = false; } },
        cursor({ line, column }) { e.cursor.textContent = `Ln ${line}, Col ${column}`; },
        mode(mode, subMode) {
            e.mode.textContent = (mode === "visual" && subMode ? `VISUAL ${subMode}` : mode).toUpperCase();
            e.mode.dataset.mode = mode.toUpperCase();
        },
        dispose() { disposed = true; handlers.abort(); stopDrag(); e.help.close(); },
    };
}
