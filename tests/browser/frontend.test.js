import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountApp } from "../../src/frontend/app.js";
import { createExplorer } from "../../src/frontend/explorer.js";
import "../../src/frontend/primer.css";

const [markup, stylesheet] = await Promise.all(["/index.html", "/editor.css"].map(async (url) => (await fetch(url)).text()));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const mounted = [];
afterEach(() => {
    for (const app of mounted.splice(0)) app.dispose();
    document.body.replaceChildren();
    delete document.documentElement.dataset.canvasTheme;
    delete document.documentElement.dataset.colorMode;
    delete document.documentElement.dataset.showKeyboardShortcutIndicators;
    for (const property of ["--editor-accent", "--editor-accent-contrast", "--editor-surface", "--editor-page",
        "--editor-canvas", "--editor-text", "--editor-muted", "--editor-border", "--editor-soft",
        "--editor-selection", "--editor-success", "--editor-warning", "--editor-danger", "--editor-important",
        "--tree-folder-color", "--tree-markdown-color"]) {
        document.documentElement.style.removeProperty(property);
    }
    vi.restoreAllMocks();
});

function fakeApi() {
    const files = new Map([
        ["/work/a.md", "# Title\n\nfirst line\nsecond line"],
        ["/work/b.js", "const value = 1;\nconsole.log(value);"],
    ]);
    let revision = 0;
    let current = { path: "/work/a.md", name: "a.md", content: files.get("/work/a.md"), revision: "r0", diskHash: "d0", dirty: false, conflict: false };
    let settings = { relativeLineNumbers: false, showKeyboardShortcutIndicators: true, theme: "system" };
    let items = [];
    const tree = () => ({ root: "/work", rootName: "work", entries: [...files.keys()].map((path) => ({ path, name: path.split("/").pop(), type: "file" })) });
    const api = vi.fn(async (path, input) => {
        if (path === "document" || path.startsWith("document?")) return { ...current };
        if (path === "settings") {
            if (input) settings = { ...settings, ...input };
            return { ...settings };
        }
        if (path === "draft") {
            current = { ...current, content: input.content, dirty: true, revision: `r${++revision}` };
            return { ...current };
        }
        if (path === "save") {
            files.set(current.path, current.content);
            current = { ...current, dirty: false, revision: `r${++revision}` };
            return { ...current };
        }
        if (path === "open") {
            const target = input.path.startsWith("/") ? input.path : `/work/${input.path}`;
            current = { path: target, name: target.split("/").pop(), content: files.get(target), revision: `r${++revision}`, diskHash: "d0", dirty: false, conflict: false };
            return { ...current };
        }
        if (path.startsWith("tree")) return tree();
        if (path === "review") return { items: [...items] };
        if (path === "review/add") {
            items.push({ ...input, id: `item-${items.length}`, label: `${input.path.split("/").pop()}:1`, lines: input.lines ?? [{ start: 1, end: 1 }] });
            return { items: [...items] };
        }
        if (path === "review/edit") {
            items = items.map((item) => item.id === input.id ? { ...item, prompt: input.prompt } : item);
            return { items: [...items] };
        }
        if (path === "review/remove") items = items.filter((item) => !input.ids.includes(item.id));
        else if (path === "review/send" || path === "review/clear") items = [];
        else if (path === "reload") {
            current = { ...current, content: files.get(current.path), revision: `r${++revision}`, dirty: false, conflict: false };
            return { ...current };
        } else if (path === "agent") return {};
        else throw new Error(`Unexpected API call ${path}`);
        return { items: [...items] };
    });
    return { api, files };
}

async function fixture({ dev = false, ...options } = {}) {
    const body = new DOMParser().parseFromString(markup, "text/html").body;
    document.body.innerHTML = body.innerHTML;
    if (dev) document.querySelector(".controls").insertAdjacentHTML("afterbegin",
        '<button id="dev-reload-button" type="button">Reload canvas</button>');
    const style = document.createElement("style");
    style.textContent = stylesheet;
    document.body.prepend(style);
    const backend = fakeApi();
    const app = mountApp({ root: document, api: backend.api, confirm: () => true, pollInterval: 60000, ...options });
    mounted.push(app);
    await app.ready;
    await expect.poll(() => document.querySelectorAll(".tree-row").length).toBe(2);
    return { app, ...backend };
}
const $ = (id) => document.getElementById(id);
const key = (text) => userEvent.keyboard(text);
async function showSidebar() {
    if ($("shell").dataset.sidebar !== "open") await userEvent.click($("toggle-explorer"));
}
async function insert(app, text) {
    app.editor.focus();
    await key("i");
    await key(text);
    await key("{Escape}");
    await expect.poll(() => app.controller.getState().dirty).toBe(false);
}

describe("mounted frontend with real CodeMirror", () => {
    it("rebuilds before reloading the dev canvas and blocks duplicate clicks", async () => {
        const reloadCanvas = vi.fn();
        const { app, api } = await fixture({ dev: true, reloadCanvas });
        const build = deferred();
        const original = api.getMockImplementation();
        api.mockImplementation((path, input) => path === "dev/reload" ? build.promise : original(path, input));
        const flush = vi.spyOn(app.controller, "flushDraft");
        await userEvent.click($("dev-reload-button"));
        expect($("dev-reload-button").disabled).toBe(true);
        expect($("dev-reload-button").textContent).toBe("Rebuilding...");
        $("dev-reload-button").click();
        expect(api.mock.calls.filter(([path]) => path === "dev/reload")).toHaveLength(1);
        expect(flush).not.toHaveBeenCalled();
        expect(reloadCanvas).not.toHaveBeenCalled();
        build.resolve({});
        await expect.poll(() => reloadCanvas.mock.calls.length).toBe(1);
        expect(flush).toHaveBeenCalledOnce();
    });

    it("keeps the editor open and allows retry after a dev rebuild failure", async () => {
        const reloadCanvas = vi.fn();
        const { api } = await fixture({ dev: true, reloadCanvas });
        const original = api.getMockImplementation();
        let failed = true;
        api.mockImplementation((path, input) => {
            if (path !== "dev/reload") return original(path, input);
            return failed ? Promise.reject(new Error("Build failed: syntax error")) : Promise.resolve({});
        });
        await userEvent.click($("dev-reload-button"));
        await expect.poll(() => $("notice-text").textContent).toContain("Build failed: syntax error");
        expect($("dev-reload-button").disabled).toBe(false);
        expect(reloadCanvas).not.toHaveBeenCalled();
        failed = false;
        await userEvent.click($("dev-reload-button"));
        await expect.poll(() => reloadCanvas.mock.calls.length).toBe(1);
    });

    it("does not reload if preserving the draft fails", async () => {
        const reloadCanvas = vi.fn();
        const { app, api } = await fixture({ dev: true, reloadCanvas });
        const original = api.getMockImplementation();
        api.mockImplementation((path, input) => path === "dev/reload" ? Promise.resolve({}) : original(path, input));
        vi.spyOn(app.controller, "flushDraft").mockRejectedValue(new Error("Draft conflict"));
        await userEvent.click($("dev-reload-button"));
        await expect.poll(() => $("notice-text").textContent).toContain("Draft conflict");
        expect($("dev-reload-button").disabled).toBe(false);
        expect(reloadCanvas).not.toHaveBeenCalled();
    });

    const longMarkdown = Array.from({ length: 100 }, (_, index) =>
        `## Section ${index + 1}\n\nParagraph with **formatted text**, a [link](https://example.com), and enough words to wrap across several lines in the editor.\n\n- First item\n- Second item\n`).join("\n");
    const scrollProgress = (pane) => pane.scrollTop / (pane.scrollHeight - pane.clientHeight);
    const scrollToProgress = (pane, progress) => { pane.scrollTop = progress * (pane.scrollHeight - pane.clientHeight); };
    const nextFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    it("keeps the cursor position when the document is replaced from disk", async () => {
        const { app, files } = await fixture();
        const view = app.editor.view;
        view.dispatch({ selection: { anchor: 12 } });
        files.set("/work/a.md", "# Title\n\nfirst line changed\nsecond line");
        await app.controller.reload();
        expect(app.editor.readText()).toContain("first line changed");
        expect(view.state.selection.main.head).toBe(12);
    });

    it("keeps large-file editing available during background saves without save-status DOM updates", async () => {
        const { app, api, files } = await fixture();
        files.set("/work/a.md", longMarkdown);
        await app.controller.reload();
        const entered = deferred(), held = deferred();
        const request = api.getMockImplementation();
        api.mockImplementation(async (path, input) => {
            if (path === "save") { entered.resolve(); await held.promise; }
            return request(path, input);
        });
        const mutations = [];
        const observer = new MutationObserver((records) => mutations.push(...records));
        for (const id of ["filename", "draft-status", "save-status"]) {
            observer.observe($(id), { subtree: true, childList: true, characterData: true, attributes: true });
        }
        try {
            app.editor.view.dispatch({ changes: { from: 0, insert: "First " } });
            await entered.promise;
            app.editor.focus();
            await key("i");
            await key("Still typing ");
            expect(app.editor.readText()).toContain("Still typing ");
            expect(app.controller.getState().localPending).toBe(true);
            expect(app.editor.view.hasFocus).toBe(true);
            expect($("save-status").hidden).toBe(true);
            expect($("draft-status").textContent).toBe("");
            expect($("filename").textContent).toBe("a.md");
            held.resolve();
            await app.controller.save();
            await nextFrames();
            expect(files.get("/work/a.md")).toBe(app.editor.readText());
            expect(mutations).toHaveLength(0);
        } finally {
            held.resolve();
            observer.disconnect();
        }
    });

    it("shows Markdown headings in a separate outline tab and jumps to their exact source lines", async () => {
        const { app, files } = await fixture();
        files.set("/work/a.md", [
            "# **Title**", "", "## [Linked](https://example.com) `code`", "",
            "```md", "# Not a heading", "```", "", "~~~", "## Also code", "~~~", "",
            "    # Indented code", "", "Underlined", "----------", "",
            "### Same", "", "### Same", "", "###### Deep", "", "Closing ###", "=======",
        ].join("\r\n"));
        await app.controller.reload();
        await showSidebar();
        await userEvent.click($("outline-tab"));
        expect($("files-panel").hidden).toBe(true);
        expect(getComputedStyle($("files-panel")).display).toBe("none");
        expect($("outline-tab").getAttribute("aria-selected")).toBe("true");
        expect($("outline-name").textContent).toBe("a.md");
        const rows = [...$("outline").querySelectorAll(".outline-row")];
        expect(rows.map((row) => row.querySelector(".tree-label").textContent)).toEqual([
            "Title", "Linked code", "Underlined", "Same", "Same", "Deep", "Closing ###",
        ]);
        expect(rows.map((row) => Number(row.dataset.line))).toEqual([1, 3, 15, 18, 20, 22, 24]);
        expect(rows.map((row) => row.querySelector(".outline-level").textContent)).toEqual(["H1", "H2", "H2", "H3", "H3", "H6", "H1"]);
        expect(parseInt(rows[5].style.paddingLeft)).toBeGreaterThan(parseInt(rows[1].style.paddingLeft));
        await userEvent.click(rows[4]);
        expect(app.editor.view.state.doc.lineAt(app.editor.view.state.selection.main.head).number).toBe(20);
        expect(app.editor.view.hasFocus).toBe(true);
        expect(rows[4].getAttribute("aria-current")).toBe("location");

        await showSidebar();
        await userEvent.click($("files-tab"));
        expect($("outline-panel").hidden).toBe(true);
        expect($("tree").querySelector(".active").dataset.path).toBe("/work/a.md");
        await userEvent.click($("outline-tab"));
        expect($("outline").querySelectorAll(".outline-row")).toHaveLength(7);
    });

    it("updates the outline after local edits, undo, external reloads and file switches", async () => {
        const { app, files } = await fixture();
        await showSidebar();
        await userEvent.click($("outline-tab"));
        app.editor.view.dispatch({ changes: { from: app.editor.view.state.doc.length, insert: "\n\n## New **section**" } });
        await expect.poll(() => $("outline").querySelectorAll(".outline-row").length).toBe(2);
        expect($("outline").lastElementChild.querySelector(".tree-label").textContent).toBe("New section");
        app.editor.focus();
        await key("u");
        await expect.poll(() => $("outline").querySelectorAll(".outline-row").length).toBe(1);
        files.set("/work/a.md", "No headings");
        await app.controller.reload();
        expect($("outline").textContent).toBe("No headings in this document.");
        expect($("outline").hasAttribute("aria-activedescendant")).toBe(false);
        files.set("/work/a.md", "External title\n===\n\n## Updated");
        await app.controller.reload();
        expect($("outline").querySelectorAll(".outline-row")).toHaveLength(2);

        await app.controller.open("/work/b.js");
        expect($("outline-name").textContent).toBe("b.js");
        expect($("outline").textContent).toBe("Outline is available for Markdown files.");
        expect($("outline").hasAttribute("aria-activedescendant")).toBe(false);
        await app.controller.open("/work/a.md");
        expect($("outline").querySelectorAll(".outline-row")).toHaveLength(2);
        expect($("outline-tab").getAttribute("aria-selected")).toBe("true");
    });

    it("supports accessible sidebar tabs and Vim outline motions without losing outline focus", async () => {
        const { app, files } = await fixture();
        files.set("/work/a.md", "# First\n\n## Second\n\n### Third");
        await app.controller.reload();
        await showSidebar();
        $("files-tab").focus();
        await key("{ArrowRight}");
        expect(document.activeElement).toBe($("outline-tab"));
        expect($("files-tab").tabIndex).toBe(-1);
        await key("{ArrowDown}");
        expect(document.activeElement).toBe($("outline"));
        const selected = () => $("outline").querySelector('[aria-selected="true"]');
        await key("j");
        expect(selected().dataset.line).toBe("3");
        await key(" ");
        expect(document.activeElement).toBe($("outline"));
        expect(app.editor.view.state.doc.lineAt(app.editor.view.state.selection.main.head).number).toBe(3);
        await key("G");
        expect(selected().dataset.line).toBe("5");
        await key("gg");
        expect(selected().dataset.line).toBe("1");
        await key("{End}{ArrowUp}");
        expect(selected().dataset.line).toBe("3");
        await key("{Enter}");
        expect(app.editor.view.hasFocus).toBe(true);
        await key("{Control>}w{/Control}h");
        expect(document.activeElement).toBe($("outline"));
        await key("{Control>}w{/Control}l");
        expect(app.editor.view.hasFocus).toBe(true);
        await key("{Control>}w{/Control}h");
        await key("q");
        expect($("shell").dataset.sidebar).toBe("closed");
        await userEvent.click($("toggle-explorer"));
        expect(document.activeElement).toBe($("outline"));
        await key("{Escape}");
        expect(app.editor.view.hasFocus).toBe(true);
        await showSidebar();
        $("outline-tab").focus();
        await key("{Home}");
        expect(document.activeElement).toBe($("files-tab"));
        expect($("files-panel").hidden).toBe(false);
    });

    it("reveals the source when jumping from preview-only and follows the editor's current section", async () => {
        const { app, files } = await fixture();
        files.set("/work/a.md", "# First\n\nText\n\n## Next\n\nMore text");
        await app.controller.reload();
        app.editor.jumpTo(7);
        await userEvent.click(document.querySelector('[data-layout="preview"]'));
        await showSidebar();
        await userEvent.click($("outline-tab"));
        expect($("outline").querySelector('[aria-current="location"]').dataset.line).toBe("5");
        await userEvent.click($("outline").firstElementChild);
        expect($("workspace").dataset.layout).toBe("split");
        expect(app.editor.view.hasFocus).toBe(true);
        expect(app.editor.view.state.selection.main.head).toBe(0);
        expect($("outline").querySelector('[aria-current="location"]').dataset.line).toBe("1");
    });

    it("syncs scrolling in either direction across different content heights without feedback", async () => {
        const { app, files } = await fixture();
        files.set("/work/a.md", longMarkdown);
        await app.controller.reload();
        const source = app.editor.view.scrollDOM, preview = $("preview");
        await expect.poll(() => source.scrollHeight).toBeGreaterThan(source.clientHeight);
        expect(preview.scrollHeight).toBeGreaterThan(preview.clientHeight);
        expect(source.scrollHeight).not.toBe(preview.scrollHeight);
        await nextFrames();

        for (const pane of [source, preview]) {
            const other = pane === source ? preview : source;
            for (const progress of [0.35, 0.7, 1, 0]) {
                scrollToProgress(pane, progress);
                await expect.poll(() => Math.abs(scrollProgress(other) - scrollProgress(pane))).toBeLessThan(0.005);
                await nextFrames();
                expect(Math.abs(scrollProgress(pane) - progress)).toBeLessThan(0.03);
                expect(scrollProgress(other)).toBeCloseTo(scrollProgress(pane), 2);
            }
        }
    });

    it("retains scroll progress through layout changes and live preview updates", async () => {
        const { app, files } = await fixture();
        files.set("/work/a.md", longMarkdown);
        await app.controller.reload();
        const source = app.editor.view.scrollDOM, preview = $("preview");
        await nextFrames();
        scrollToProgress(preview, 0.6);
        await expect.poll(() => Math.abs(scrollProgress(source) - scrollProgress(preview))).toBeLessThan(0.005);
        expect(Math.abs(scrollProgress(preview) - 0.6)).toBeLessThan(0.03);
        await userEvent.click(document.querySelector('[data-layout="preview"]'));
        await nextFrames();
        scrollToProgress(preview, 0.3);
        await nextFrames();
        await userEvent.click(document.querySelector('[data-layout="split"]'));
        await expect.poll(() => Math.abs(scrollProgress(source) - scrollProgress(preview))).toBeLessThan(0.005);
        expect(Math.abs(scrollProgress(preview) - 0.3)).toBeLessThan(0.03);

        app.editor.view.dispatch({ changes: { from: app.editor.view.state.doc.length, insert: `\n${longMarkdown}` } });
        await expect.poll(() => preview.querySelectorAll("h2").length).toBe(200);
        await expect.poll(() => Math.abs(scrollProgress(preview) - scrollProgress(source))).toBeLessThan(0.01);
    });

    it("resets scrolling on file switches and handles documents without overflow", async () => {
        const { app, files } = await fixture();
        files.set("/work/a.md", longMarkdown);
        await app.controller.reload();
        const source = app.editor.view.scrollDOM, preview = $("preview");
        await nextFrames();
        scrollToProgress(source, 0.8);
        await expect.poll(() => Math.abs(scrollProgress(preview) - scrollProgress(source))).toBeLessThan(0.005);
        expect(scrollProgress(preview)).toBeGreaterThan(0.7);
        await app.controller.open("/work/b.js");
        await nextFrames();
        expect(source.scrollTop).toBe(0);
        await app.controller.open("/work/a.md");
        await expect.poll(() => preview.scrollTop).toBe(0);
        expect(source.scrollTop).toBe(0);

        files.set("/work/a.md", "# Short");
        await app.controller.reload();
        await nextFrames();
        expect(preview.scrollTop).toBe(0);
        expect(source.scrollTop).toBe(0);
        expect(preview.scrollHeight).toBe(preview.clientHeight);
    });

    it("applies the selected editor theme to the full canvas and follows system mode", async () => {
        document.documentElement.dataset.colorMode = "dark";
        await fixture();
        expect(document.documentElement.dataset.canvasTheme).toBe("dark");
        expect(getComputedStyle(document.documentElement).getPropertyValue("--editor-canvas").trim()).toBe("#0d1117");
        expect(getComputedStyle(document.documentElement).getPropertyValue("--editor-accent").trim()).toBe("#79c0ff");

        await userEvent.click($("settings-button"));
        await userEvent.selectOptions($("editor-theme"), "dracula");
        await expect.poll(() => getComputedStyle(document.documentElement).getPropertyValue("--editor-canvas").trim()).toBe("#282a36");
        expect(document.documentElement.dataset.canvasTheme).toBe("dark");
        expect(getComputedStyle(document.documentElement).getPropertyValue("--editor-accent").trim()).toBe("#8be9fd");

        await userEvent.selectOptions($("editor-theme"), "solarized-light");
        await expect.poll(() => getComputedStyle(document.documentElement).getPropertyValue("--editor-canvas").trim()).toBe("#fdf6e3");
        expect(document.documentElement.dataset.canvasTheme).toBe("light");
        expect(getComputedStyle(document.documentElement).getPropertyValue("--editor-accent").trim()).toBe("#268bd2");

        await userEvent.selectOptions($("editor-theme"), "system");
        await expect.poll(() => getComputedStyle(document.documentElement).getPropertyValue("--editor-canvas").trim()).toBe("#0d1117");
        expect(document.documentElement.dataset.canvasTheme).toBe("dark");
        document.documentElement.dataset.colorMode = "light";
        await expect.poll(() => document.documentElement.dataset.canvasTheme).toBe("light");
        expect(getComputedStyle(document.documentElement).getPropertyValue("--editor-canvas").trim()).toBe("#ffffff");
        expect(getComputedStyle(document.documentElement).getPropertyValue("--editor-accent").trim()).toBe("#0550ae");
    });

    it("edits through Vim, autosaves, reports cursor/mode and preserves settings without rebuilding state", async () => {
        const { app, api } = await fixture();
        expect($("preview").querySelector("h1").textContent).toBe("Title");
        await insert(app, "typed ");
        expect(app.editor.readText()).toContain("typed ");
        expect($("mode").textContent).toBe("NORMAL");
        expect($("cursor").textContent).toMatch(/Ln 1, Col \d+/);
        const selection = app.editor.view.state.selection.main.head;
        const content = app.editor.readText();
        await userEvent.click($("settings-button"));
        await expect.poll(() => $("settings-status").textContent).toBe("");
        await userEvent.click($("relative-line-numbers"));
        await userEvent.selectOptions($("editor-theme"), "dracula");
        await userEvent.click($("save-settings"));
        await expect.poll(() => $("settings-status").textContent).toBe("Settings saved.");
        expect($("settings").open).toBe(false);
        expect(app.editor.readText()).toBe(content);
        expect(app.editor.view.state.selection.main.head).toBe(selection);
        app.editor.focus();
        await key("u");
        await expect.poll(() => app.editor.readText()).toBe("# Title\n\nfirst line\nsecond line");
        expect(api.mock.calls.some(([path, input]) => path === "settings" && input?.relativeLineNumbers)).toBe(true);
    });

    it("keeps Vim visual selections visible on the cursor line", async () => {
        const { app } = await fixture();
        const activeLine = () => getComputedStyle(document.querySelector(".cm-activeLine")).backgroundColor;
        const visibleSelection = () => [...document.querySelectorAll(".cm-selectionBackground")]
            .some((marker) => marker.getBoundingClientRect().width > 0) && activeLine() === "rgba(0, 0, 0, 0)";
        app.editor.focus();
        expect(activeLine()).not.toBe("rgba(0, 0, 0, 0)");
        await key("jjV");
        await expect.poll(visibleSelection).toBe(true);
        await key("{Escape}");
        await expect.poll(activeLine).not.toBe("rgba(0, 0, 0, 0)");
        await insert(app, "(inner) ");
        await key("0fivi(");
        expect(app.editor.view.state.sliceDoc(app.editor.view.state.selection.main.from, app.editor.view.state.selection.main.to)).toBe("inner");
        await expect.poll(visibleSelection).toBe(true);
    });

    it("shows or hides keyboard shortcut indicators throughout the canvas without disabling shortcuts", async () => {
        const { app } = await fixture();
        expect(document.documentElement.dataset.showKeyboardShortcutIndicators).toBe("true");
        expect(getComputedStyle(document.querySelector(".explorer-hint")).display).not.toBe("none");
        app.editor.focus();
        await key("{Control>}i{/Control}");
        await expect.poll(() => document.querySelector(".agent-prompt")).toBeTruthy();

        await userEvent.click($("settings-button"));
        await userEvent.click($("show-keyboard-shortcut-indicators"));
        expect($("settings-status").textContent).toBe("Unsaved changes.");
        expect(document.documentElement.dataset.showKeyboardShortcutIndicators).toBe("false");
        expect(getComputedStyle(document.querySelector(".explorer-hint")).display).toBe("none");
        expect(getComputedStyle(document.querySelector(".agent-actions kbd")).display).toBe("none");
        expect(getComputedStyle($("review-send").querySelector("kbd")).display).toBe("none");
        expect(getComputedStyle(document.querySelector(".agent-hint")).display).toBe("none");
        expect(getComputedStyle($("help").querySelector(".shortcut-section")).display).toBe("none");

        await userEvent.click($("show-keyboard-shortcut-indicators"));
        expect($("settings-status").textContent).toBe("");
        expect(document.documentElement.dataset.showKeyboardShortcutIndicators).toBe("true");
        expect(getComputedStyle(document.querySelector(".agent-actions kbd")).display).not.toBe("none");
        expect(getComputedStyle($("review-send").querySelector("kbd")).display).not.toBe("none");
        await userEvent.click($("close-settings"));
        const promptInput = document.querySelector('.agent-prompt [aria-label="Agent prompt"]');
        await userEvent.click(promptInput);
        await key("shortcut still works{Enter}");
        await expect.poll(() => document.querySelector(".agent-prompt")).toBeNull();
    });

    it("previews settings without writing or rebuilding unrelated editor state, then persists only on Save", async () => {
        const { app, api } = await fixture();
        await userEvent.click($("settings-button"));
        await expect.poll(() => $("settings-status").textContent).toBe("");
        const response = deferred();
        const original = api.getMockImplementation();
        api.mockImplementation((path, input) => path === "settings" && input ? response.promise : original(path, input));
        const state = app.editor.view.state;
        const theme = app.editor.currentTheme();
        const dispatch = vi.spyOn(app.editor.view, "dispatch");
        const repaint = vi.spyOn(document.documentElement.style, "setProperty");
        const before = $("settings").getBoundingClientRect();
        const disabledChanges = [];
        const observer = new MutationObserver((records) => disabledChanges.push(...records));
        for (const id of ["relative-line-numbers", "show-keyboard-shortcut-indicators", "editor-theme"]) {
            observer.observe($(id), { attributes: true, attributeFilter: ["disabled"] });
        }
        try {
            expect($("save-settings").disabled).toBe(true);
            expect($("discard-settings").disabled).toBe(true);
            api.mockClear();
            await userEvent.click($("show-keyboard-shortcut-indicators"));
            expect($("settings-status").textContent).toBe("Unsaved changes.");
            expect(api).not.toHaveBeenCalled();
            expect(document.documentElement.dataset.showKeyboardShortcutIndicators).toBe("false");
            expect(getComputedStyle(document.querySelector(".explorer-hint")).display).toBe("none");
            expect(document.activeElement).toBe($("show-keyboard-shortcut-indicators"));
            for (const id of ["relative-line-numbers", "show-keyboard-shortcut-indicators", "editor-theme"]) {
                expect($(id).disabled).toBe(false);
            }
            expect($("settings").getBoundingClientRect().height).toBe(before.height);
            expect($("settings").getBoundingClientRect().top).toBe(before.top);
            expect(app.editor.view.state).toBe(state);
            expect(app.editor.currentTheme()).toBe(theme);
            expect(dispatch).not.toHaveBeenCalled();
            expect(repaint).not.toHaveBeenCalled();

            await userEvent.click($("save-settings"));
            expect(api).toHaveBeenCalledExactlyOnceWith("settings", { showKeyboardShortcutIndicators: false });
            expect($("settings-status").textContent).toBe("Saving settings...");
            expect($("save-settings").disabled).toBe(true);
            expect($("discard-settings").disabled).toBe(true);
            response.resolve(await original("settings", { showKeyboardShortcutIndicators: false }));
            await expect.poll(() => $("settings-status").textContent).toBe("Settings saved.");
            expect($("settings").open).toBe(false);
            expect(app.editor.view.state).toBe(state);
            expect(dispatch).not.toHaveBeenCalled();
            expect(repaint).not.toHaveBeenCalled();
            expect(disabledChanges).toHaveLength(0);

            api.mockImplementation(original);
            await userEvent.click($("settings-button"));
            await expect.poll(() => $("settings-status").textContent).toBe("");
            await userEvent.click($("relative-line-numbers"));
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(app.editor.currentTheme()).toBe(theme);
            expect(repaint).not.toHaveBeenCalled();
        } finally { observer.disconnect(); }
    });

    it("saves a snapshot without automatically persisting newer previews or letting the response overwrite them", async () => {
        const { app, api } = await fixture();
        await userEvent.click($("settings-button"));
        await expect.poll(() => $("settings-status").textContent).toBe("");
        const writes = [];
        const original = api.getMockImplementation();
        api.mockImplementation((path, input) => {
            if (path !== "settings" || !input) return original(path, input);
            const response = deferred();
            writes.push({ input, ...response });
            return response.promise;
        });
        await userEvent.click($("show-keyboard-shortcut-indicators"));
        await userEvent.click($("show-keyboard-shortcut-indicators"));
        await userEvent.click($("show-keyboard-shortcut-indicators"));
        await userEvent.click($("show-keyboard-shortcut-indicators"));
        await userEvent.click($("relative-line-numbers"));
        await userEvent.selectOptions($("editor-theme"), "dracula");
        expect(writes).toHaveLength(0);
        expect(document.documentElement.dataset.showKeyboardShortcutIndicators).toBe("true");
        expect(getComputedStyle(document.documentElement).getPropertyValue("--editor-canvas").trim()).toBe("#282a36");
        await userEvent.click($("save-settings"));
        expect(writes).toHaveLength(1);
        expect(writes[0].input).toEqual({ relativeLineNumbers: true, theme: "dracula" });
        await userEvent.selectOptions($("editor-theme"), "nord");
        await userEvent.click($("show-keyboard-shortcut-indicators"));
        expect($("close-settings").disabled).toBe(true);
        expect($("discard-settings").disabled).toBe(true);
        $("save-settings").click();
        await key("{Escape}");
        expect($("settings").open).toBe(true);
        const theme = app.editor.currentTheme();
        writes[0].resolve(await original("settings", writes[0].input));
        await expect.poll(() => $("settings-status").textContent).toBe("Unsaved changes.");
        expect(writes).toHaveLength(1);
        expect((await original("settings")).theme).toBe("dracula");
        expect($("show-keyboard-shortcut-indicators").checked).toBe(false);
        expect($("relative-line-numbers").checked).toBe(true);
        expect($("editor-theme").value).toBe("nord");
        expect(app.editor.currentTheme()).toBe(theme);
        await userEvent.click($("save-settings"));
        expect(writes).toHaveLength(2);
        expect(writes[1].input).toEqual({ showKeyboardShortcutIndicators: false, theme: "nord" });
        writes[1].resolve(await original("settings", writes[1].input));
        await expect.poll(() => $("settings-status").textContent).toBe("Settings saved.");
        expect(await original("settings")).toEqual({ showKeyboardShortcutIndicators: false, relativeLineNumbers: true, theme: "nord" });
    });

    it("ignores a stale settings refresh and keeps failed Save previews available for retry", async () => {
        const { api } = await fixture();
        const original = api.getMockImplementation();
        const refresh = deferred(), first = deferred(), second = deferred();
        let writes = 0;
        api.mockImplementation((path, input) => {
            if (path !== "settings") return original(path, input);
            if (!input) return refresh.promise;
            return ++writes === 1 ? first.promise : second.promise;
        });
        await userEvent.click($("settings-button"));
        await userEvent.click($("show-keyboard-shortcut-indicators"));
        refresh.resolve({ relativeLineNumbers: false, theme: "dracula", showKeyboardShortcutIndicators: true });
        await expect.poll(() => $("settings-status").textContent).toBe("Unsaved changes.");
        expect(document.documentElement.dataset.showKeyboardShortcutIndicators).toBe("false");
        expect($("editor-theme").value).toBe("system");
        expect(writes).toBe(0);
        await userEvent.click($("relative-line-numbers"));
        await userEvent.click($("save-settings"));
        first.reject(new Error("Disk unavailable"));
        await expect.poll(() => $("settings-status").textContent).toContain("Disk unavailable");
        expect($("settings").open).toBe(true);
        expect(writes).toBe(1);
        expect($("show-keyboard-shortcut-indicators").checked).toBe(false);
        expect($("relative-line-numbers").checked).toBe(true);
        expect(await original("settings")).toEqual({ relativeLineNumbers: false, theme: "system", showKeyboardShortcutIndicators: true });
        await userEvent.click($("save-settings"));
        expect(writes).toBe(2);
        second.resolve(await original("settings", { relativeLineNumbers: true, showKeyboardShortcutIndicators: false }));
        await expect.poll(() => $("settings-status").textContent).toBe("Settings saved.");
        expect(await original("settings")).toEqual({ relativeLineNumbers: true, theme: "system", showKeyboardShortcutIndicators: false });
    });

    it.each(["discard-settings", "close-settings", "Escape"])("restores the last saved settings without a write on %s", async (action) => {
        const { app, api } = await fixture();
        await userEvent.click($("settings-button"));
        await expect.poll(() => $("settings-status").textContent).toBe("");
        const original = api.getMockImplementation();
        await userEvent.selectOptions($("editor-theme"), "dracula");
        await userEvent.click($("relative-line-numbers"));
        await userEvent.click($("save-settings"));
        await expect.poll(() => $("settings-status").textContent).toBe("Settings saved.");
        expect($("settings").open).toBe(false);
        const saved = await original("settings");
        const content = app.editor.readText();
        const selection = app.editor.view.state.selection;
        await userEvent.click($("settings-button"));
        await expect.poll(() => $("settings-status").textContent).toBe("");
        api.mockClear();
        await userEvent.selectOptions($("editor-theme"), "nord");
        await userEvent.click($("relative-line-numbers"));
        await userEvent.click($("show-keyboard-shortcut-indicators"));
        if (action === "Escape") await key("{Escape}");
        else await userEvent.click($(action));
        await expect.poll(() => $("editor-theme").value).toBe("dracula");
        expect($("relative-line-numbers").checked).toBe(true);
        expect($("show-keyboard-shortcut-indicators").checked).toBe(true);
        expect(getComputedStyle(document.documentElement).getPropertyValue("--editor-canvas").trim()).toBe("#282a36");
        expect(document.documentElement.dataset.showKeyboardShortcutIndicators).toBe("true");
        expect(app.editor.readText()).toBe(content);
        expect(app.editor.view.state.selection).toBe(selection);
        expect(api).not.toHaveBeenCalled();
        expect(await original("settings")).toEqual(saved);
        expect($("settings").open).toBe(action === "discard-settings");
        expect($("save-settings").disabled).toBe(true);
        expect($("discard-settings").disabled).toBe(true);
    });

    it("invalidates a pending settings refresh when the dialog is closed", async () => {
        const { api } = await fixture();
        const refresh = deferred();
        const original = api.getMockImplementation();
        api.mockImplementation((path, input) => path === "settings" ? refresh.promise : original(path, input));
        await userEvent.click($("settings-button"));
        await userEvent.selectOptions($("editor-theme"), "dracula");
        await userEvent.click($("close-settings"));
        refresh.resolve({ relativeLineNumbers: true, theme: "nord", showKeyboardShortcutIndicators: false });
        await Promise.resolve();
        await Promise.resolve();
        expect($("editor-theme").value).toBe("system");
        expect($("relative-line-numbers").checked).toBe(false);
        expect($("show-keyboard-shortcut-indicators").checked).toBe(true);
    });

    it("navigates explorer with keyboard, loads a local language, restores Markdown layout and resets per-file undo", async () => {
        const { app } = await fixture();
        await userEvent.click(document.querySelector('[data-layout="preview"]'));
        expect($("workspace").dataset.layout).toBe("preview");
        await userEvent.click($("toggle-explorer"));
        await expect.poll(() => document.activeElement?.id).toBe("tree");
        await key("j{Enter}");
        await expect.poll(() => app.controller.getState().current.name).toBe("b.js");
        expect($("workspace").dataset.layout).toBe("edit");
        expect($("layout-controls").hidden).toBe(true);
        await expect.poll(() => $("filetype").textContent).toBe("JavaScript");
        await insert(app, "// changed ");
        await app.controller.open("/work/a.md");
        expect($("workspace").dataset.layout).toBe("preview");
        expect($("layout-controls").hidden).toBe(false);
        app.editor.focus();
        await key("u");
        expect(app.editor.readText()).toBe("# Title\n\nfirst line\nsecond line");
    });

    it("preserves authentication hash for heading links and only opens safe web URLs", async () => {
        const { app } = await fixture();
        const oldHash = location.hash;
        location.hash = "test-auth-token";
        try {
            app.editor.view.dispatch({ changes: { from: 0, to: app.editor.view.state.doc.length,
                insert: "# Target\n\n[here](#target) [web](https://example.com) [file](file:///etc/passwd)" } });
            await expect.poll(() => $("preview").querySelectorAll("a").length).toBe(3);
            const [heading, web, file] = $("preview").querySelectorAll("a");
            await userEvent.click(heading);
            expect(location.hash).toBe("#test-auth-token");
            expect(web.target).toBe("_blank");
            expect(web.rel).toBe("noopener noreferrer");
            expect(file.hasAttribute("href")).toBe(false);
        } finally { location.hash = oldHash; }
    });

    it("shows a visible caret, three-line input and shortcut badges in the agent prompt", async () => {
        const { app } = await fixture();
        app.editor.focus();
        await key("{Control>}i{/Control}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(1);
        const prompt = document.querySelector(".agent-prompt");
        const inner = prompt.querySelector(".agent-input .cm-editor");
        await expect.poll(() => inner.classList.contains("cm-focused")).toBe(true);
        // The outer editor is in Normal mode; its Vim styles must not hide the prompt's insert caret.
        expect(document.querySelector("#editor .cm-scroller").classList.contains("cm-vimMode")).toBe(true);
        const layer = inner.querySelector(".cm-cursorLayer:not(.cm-vimCursorLayer)");
        expect(getComputedStyle(layer).display).not.toBe("none");
        await expect.poll(() => layer.querySelector(".cm-cursor") && getComputedStyle(layer.querySelector(".cm-cursor")).display).toBe("block");
        expect(getComputedStyle(layer).animationName).toMatch(/cm-blink/);

        await key("{Escape}");
        await expect.poll(() => inner.querySelector(".cm-fat-cursor")).toBeTruthy();
        const fat = getComputedStyle(inner.querySelector(".cm-fat-cursor"));
        expect(fat.backgroundColor).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
        expect(fat.outlineStyle).toBe("none");

        const content = inner.querySelector(".cm-content");
        const lineHeight = parseFloat(getComputedStyle(content.querySelector(".cm-line")).lineHeight);
        expect(content.getBoundingClientRect().height).toBeGreaterThanOrEqual(lineHeight * 3);

        const send = [...prompt.querySelectorAll(".agent-actions button")].find((el) => el.textContent.startsWith("Send to Agent"));
        expect(send.classList.contains("btn-primary")).toBe(true);
        expect(send.querySelector("kbd").textContent).toMatch(/⏎|Enter/);
        expect(getComputedStyle(send.querySelector("kbd")).display).not.toBe("none");
        expect(send.getAttribute("aria-keyshortcuts")).toBe("Enter");
        expect(prompt.querySelector(".agent-hint kbd").textContent).toMatch(/⇧⏎|Shift\+Enter/);
    });

    it("switches Agent Vim mode live without losing text and closes standard prompts with one Escape", async () => {
        const { app, api } = await fixture();
        app.editor.focus();
        await key("{Control>}i{/Control}Keep this");
        await userEvent.click($("settings-button"));
        await expect.poll(() => $("settings-status").textContent).toBe("");
        expect($("agent-vim-mode").checked).toBe(true);
        await userEvent.click($("agent-vim-mode"));
        expect(document.querySelector(".agent-header .mode").hidden).toBe(true);
        expect(api.mock.calls.filter(([path, input]) => path === "settings" && input)).toHaveLength(0);
        await userEvent.click($("discard-settings"));
        expect($("agent-vim-mode").checked).toBe(true);
        expect(document.querySelector(".agent-header .mode").hidden).toBe(false);
        expect(document.querySelector(".agent-input .cm-content").textContent).toBe("Keep this");
        expect(api.mock.calls.filter(([path, input]) => path === "settings" && input)).toHaveLength(0);
        await userEvent.click($("agent-vim-mode"));
        await userEvent.click($("save-settings"));
        await expect.poll(() => $("settings-status").textContent).toBe("Settings saved.");
        expect($("settings").open).toBe(false);
        expect(document.querySelector(".agent-header .mode").hidden).toBe(true);
        expect(document.querySelector(".agent-input .cm-content").textContent).toBe("Keep this");
        expect(document.querySelector(".agent-cancel kbd").textContent).toBe("Esc");
        await userEvent.click(document.querySelector(".agent-input .cm-content"));
        await key("{Escape}");
        expect(document.querySelectorAll(".agent-prompt")).toHaveLength(0);
        expect(app.editor.view.scrollDOM.classList.contains("cm-vimMode")).toBe(true);
        await key("{Control>}i{/Control}Standard text{Shift>}{Enter}{/Shift}Second line");
        expect(document.querySelector(".agent-input .cm-content").textContent).toContain("Standard text");
        await key("{Meta>}{Enter}{/Meta}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(0);
        expect((await api("review")).items[0].prompt).toBe("Standard text\nSecond line");
        await userEvent.click(document.querySelector(".review-marker"));
        expect(document.querySelector(".agent-input .cm-content").textContent).toContain("Standard text");
        await userEvent.click($("settings-button"));
        await expect.poll(() => $("settings-status").textContent).toBe("");
        await userEvent.click($("agent-vim-mode"));
        await userEvent.click($("save-settings"));
        await expect.poll(() => $("settings-status").textContent).toBe("Settings saved.");
        expect($("settings").open).toBe(false);
        expect(document.querySelector(".agent-header .mode").hidden).toBe(false);
        expect(document.querySelector(".agent-input .cm-content").textContent).toContain("Standard text");
        await userEvent.click(document.querySelector(".agent-input .cm-content"));
        await key("{Escape}");
        expect(document.querySelectorAll(".agent-prompt")).toHaveLength(1);
        await key("{Escape}");
        expect(document.querySelectorAll(".agent-prompt")).toHaveLength(0);
    });

    it("uses frozen selection context and prompt-local keyboard priority, with failed-send retry", async () => {
        const { app, api } = await fixture();
        app.editor.view.dispatch({ selection: { anchor: 9, head: 14 } });
        const expectedText = app.editor.view.state.sliceDoc(9, 14);
        app.editor.focus();
        await key("{Control>}i{/Control}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(1);
        const prompt = document.querySelector('.agent-prompt [aria-label="Agent prompt"]');
        await expect.poll(() => document.activeElement).toBe(prompt);
        const implementation = api.getMockImplementation();
        let attempts = 0;
        api.mockImplementation(async (path, input) => {
            if (path === "agent" && ++attempts === 1) throw new Error("network failed");
            return implementation(path, input);
        });
        app.editor.view.dispatch({ changes: { from: 0, insert: "prefix\n" } });
        await key("Please improve{Enter}");
        await expect.poll(() => document.querySelector(".agent-prompt .agent-status")?.textContent).toContain("network failed");
        expect(document.querySelectorAll(".agent-prompt").length).toBe(1);
        await key("{Enter}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(0);
        const calls = api.mock.calls.filter(([path]) => path === "agent");
        expect(calls).toHaveLength(2);
        expect(calls[1][1]).toMatchObject({ path: "/work/a.md", prompt: "Please improve", selections: [{ text: expectedText }] });
    });

    it("keeps review markers mapped through edits and unchanged review polling, then sends as a group", async () => {
        const { app, api } = await fixture();
        await api("review/add", { path: "/work/a.md", selections: [], prompt: "review", lines: [{ start: 3, end: 3 }] });
        await app.controller.poll();
        expect(document.querySelectorAll(".cm-agent-pending")).toHaveLength(1);
        app.editor.view.dispatch({ changes: { from: 0, insert: "new line\n" } });
        await app.controller.save();
        await app.controller.poll();
        await expect.poll(() => document.querySelector(".cm-agent-pending")?.textContent).toBe("first line");
        app.editor.focus();
        await key("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
        await expect.poll(() => $("review").hidden).toBe(true);
        expect(api.mock.calls.filter(([path]) => path === "review/send")).toHaveLength(1);
    });

    it("opens separate left-hand icons on the same line, toggles, edits, maps and deletes comments", async () => {
        const { app, api } = await fixture();
        for (const prompt of ["First comment", "Second comment"]) {
            await api("review/add", { path: "/work/a.md", prompt, selections: [], lines: [{ start: 3, end: 4 }] });
        }
        await app.controller.poll();
        const icons = () => [...document.querySelectorAll(".review-marker")];
        expect(icons()).toHaveLength(2);
        const contentBounds = app.editor.view.contentDOM.getBoundingClientRect();
        expect(icons()[0].getBoundingClientRect().right).toBeLessThanOrEqual(contentBounds.left);
        expect(icons()[0].getBoundingClientRect().left).toBeGreaterThanOrEqual(app.editor.view.scrollDOM.getBoundingClientRect().left);
        const lastLine = [...app.editor.view.contentDOM.querySelectorAll(":scope > .cm-line")].at(-1);
        await expect.poll(() => Math.abs(icons()[0].getBoundingClientRect().top - lastLine.getBoundingClientRect().top)).toBeLessThan(4);
        await userEvent.click(icons()[0]);
        expect(document.querySelector(".agent-input .cm-content").textContent).toBe("First comment");
        await key("{Escape}ccCancelled");
        await userEvent.click(icons()[0]);
        expect(document.querySelectorAll(".agent-prompt")).toHaveLength(0);
        expect((await api("review")).items[0].prompt).toBe("First comment");
        await userEvent.click(icons()[0]);
        expect(document.querySelector(".agent-input .cm-content").textContent).toBe("First comment");
        await userEvent.click(icons()[0]);
        expect(document.querySelectorAll(".agent-prompt")).toHaveLength(0);

        app.editor.view.dispatch({ changes: { from: 0, insert: "new line\n" } });
        await app.controller.save();
        await app.controller.poll();
        const mappedLast = [...app.editor.view.contentDOM.querySelectorAll(":scope > .cm-line")].at(-1);
        await expect.poll(() => Math.abs(icons()[1].getBoundingClientRect().top - mappedLast.getBoundingClientRect().top)).toBeLessThan(4);
        await userEvent.click(icons()[1]);
        expect(document.querySelector(".agent-input .cm-content").textContent).toBe("Second comment");
        await key("{Escape}ccUpdated comment{Enter}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(0);
        expect((await api("review")).items).toHaveLength(2);
        expect((await api("review")).items[1].prompt).toBe("Updated comment");
        expect(icons()[1].title).toContain("Updated comment");
        expect($("review-list").textContent).toContain("Updated comment");
        expect(api.mock.calls.filter(([path]) => path === "review/edit")).toHaveLength(1);
        expect(app.editor.readText()).toBe("new line\n# Title\n\nfirst line\nsecond line");
        await userEvent.click(icons()[1]);
        await userEvent.click([...document.querySelectorAll(".agent-actions button")].find((button) => button.textContent === "Delete comment"));
        await expect.poll(() => icons().length).toBe(1);
        expect((await api("review")).items[0].prompt).toBe("First comment");
        await app.controller.open("/work/b.js");
        expect(icons()).toHaveLength(0);
        await userEvent.click($("review-toggle"));
        await userEvent.click(document.querySelector(".review-edit"));
        await expect.poll(() => document.querySelector(".agent-input .cm-content")?.textContent).toBe("First comment");
        expect(app.controller.getState().current.path).toBe("/work/a.md");
    });

    it("keeps Enter and modifier Enter consistent during a review and offers send-all as a third action", async () => {
        const { app, api } = await fixture();
        await api("review/add", { path: "/work/a.md", prompt: "Pending", selections: [] });
        await app.controller.poll();
        const open = async () => {
            app.editor.focus();
            await key("{Control>}i{/Control}");
        };
        await open();
        const actions = [...document.querySelectorAll(".agent-actions button")];
        expect(actions.map((button) => button.querySelector("span")?.textContent)).toEqual(["Send to Agent", "Add to batch", "Send batch (1)", "Cancel"]);
        expect($("review").getAttribute("aria-label")).toBe("Request batch");
        expect($("review-count").textContent).toBe("1 pending request");
        expect($("review-discard").textContent).toBe("Discard batch");
        expect(getComputedStyle($("review-send").querySelector("kbd")).display).not.toBe("none");
        for (const button of actions.slice(0, 3)) {
            expect(getComputedStyle(button.querySelector("kbd")).display).not.toBe("none");
        }
        expect(actions[0].getAttribute("aria-keyshortcuts")).toBe("Enter");
        expect(actions[1].getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");
        await key("Immediate{Enter}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(0);
        expect(api.mock.calls.filter(([path]) => path === "agent")).toMatchObject([["agent", { prompt: "Immediate" }]]);
        expect((await api("review")).items).toHaveLength(1);
        await open();
        await key("Grouped{Meta>}{Enter}{/Meta}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(0);
        expect((await api("review")).items).toHaveLength(2);
        expect($("review-count").textContent).toBe("2 pending requests");
        await open();
        await key("Final{Meta>}{Shift>}{Enter}{/Shift}{/Meta}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(0);
        expect(api.mock.calls.filter(([path]) => path === "review/send")).toHaveLength(1);
        expect(api.mock.calls.filter(([path]) => path === "review/add").at(-1)[1].prompt).toBe("Final");
        expect((await api("review")).items).toHaveLength(0);
    });

    it("expands list comments across files and switches between comments in the same file", async () => {
        const { app, api } = await fixture();
        await api("review/add", { path: "/work/a.md", prompt: "First", selections: [], lines: [{ start: 1, end: 1 }] });
        await api("review/add", { path: "/work/a.md", prompt: "Multiline", selections: [], lines: [{ start: 3, end: 4 }] });
        await app.controller.poll();
        await app.controller.open("/work/b.js");
        await userEvent.click($("review-toggle"));
        const rows = () => [...document.querySelectorAll(".review-item")];
        await userEvent.click(rows()[1]);
        await expect.poll(() => document.querySelector(".agent-input .cm-content")?.textContent).toBe("Multiline");
        expect(app.controller.getState().current.path).toBe("/work/a.md");
        expect(app.editor.view.state.doc.lineAt(app.editor.view.state.selection.main.head).number).toBe(4);
        await userEvent.click(rows()[0]);
        await expect.poll(() => document.querySelector(".agent-input .cm-content")?.textContent).toBe("First");
        expect(app.editor.view.state.doc.lineAt(app.editor.view.state.selection.main.head).number).toBe(1);
        await userEvent.click(rows()[0]);
        expect(document.querySelectorAll(".agent-prompt")).toHaveLength(1);
    });

    it("keeps failed comment edits open for retry without adding or sending comments", async () => {
        const { app, api } = await fixture();
        await api("review/add", { path: "/work/a.md", prompt: "Original", selections: [] });
        await app.controller.poll();
        const original = api.getMockImplementation();
        api.mockImplementation((path, input) => path === "review/edit" ? Promise.reject(new Error("Save unavailable")) : original(path, input));
        await userEvent.click(document.querySelector(".review-marker"));
        await key("{Escape}ccRetry edit{Enter}");
        await expect.poll(() => document.querySelector(".agent-status")?.textContent).toContain("Save unavailable");
        expect(document.querySelector(".agent-input .cm-content").textContent).toBe("Retry edit");
        expect(api.mock.calls.filter(([path]) => path === "review/send" || path === "agent")).toHaveLength(0);
        api.mockImplementation(original);
        await key("{Enter}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(0);
        expect((await api("review")).items[0].prompt).toBe("Retry edit");
    });

    it("does not let feature errors change document conflict ownership", async () => {
        const { app, api } = await fixture();
        const original = api.getMockImplementation();
        api.mockImplementation((path, input) => path === "tree?dir=%2Fwork"
            ? Promise.reject(Object.assign(new Error("tree unavailable"), { code: "draft_conflict" }))
            : original(path, input));
        if ($("shell").dataset.sidebar !== "open") await userEvent.click($("toggle-explorer"));
        await userEvent.click($("refresh-tree"));
        await expect.poll(() => $("notice-text").textContent).toBe("tree unavailable");
        expect(app.controller.getState().blocked).toBe(false);
        expect($("conflict").hidden).toBe(true);
        expect($("save-status").hidden).toBe(true);
    });

    it("automatically reloads disk conflicts without marking the replacement as a local edit", async () => {
        const { app, api } = await fixture();
        const original = api.getMockImplementation();
        const server = { ...app.controller.getState().current, content: "# External\n\nDisk version", revision: "external", conflict: true };
        const response = deferred(), entered = deferred();
        api.mockImplementation((path, input) => {
            if (path.startsWith("document")) return Promise.resolve({ ...server });
            if (path === "reload") { entered.resolve(input); return response.promise; }
            return original(path, input);
        });
        const polling = app.controller.poll();
        await entered.promise;
        response.resolve({ ...server, content: "# Reloaded", conflict: false, revision: "reloaded" });
        await polling;
        expect(app.editor.readText()).toBe("# Reloaded");
        expect(app.controller.getState()).toMatchObject({
            localVersion: 0, persistedVersion: 0, localPending: false, blocked: false,
            current: { conflict: false, dirty: false },
        });
        expect(api.mock.calls.filter(([path]) => path === "draft")).toHaveLength(0);
        expect($("conflict").hidden).toBe(true);
        expect($("notice").hidden).toBe(true);
    });

    it("disposes listeners, timers, editors and prompts and can remount without duplicate actions", async () => {
        const interval = vi.spyOn(window, "setInterval");
        const clear = vi.spyOn(window, "clearInterval");
        const { app, api } = await fixture();
        app.editor.focus();
        await key("{Control>}i{/Control}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(1);
        const ownedInterval = interval.mock.results.at(-1).value;
        app.dispose();
        app.dispose();
        expect(clear).toHaveBeenCalledWith(ownedInterval);
        expect(document.querySelectorAll(".cm-editor")).toHaveLength(0);
        api.mockClear();
        await userEvent.click($("settings-button"));
        expect(api).not.toHaveBeenCalled();
        const remount = mountApp({ api, pollInterval: 60000, confirm: () => true });
        mounted.push(remount);
        await remount.ready;
        expect(document.querySelectorAll("#editor > .cm-editor")).toHaveLength(1);
        api.mockClear();
        await userEvent.click($("settings-button"));
        await expect.poll(() => api.mock.calls.filter(([path]) => path === "settings").length).toBe(1);
    });

    it("invalidates async startup and pending settings UI after teardown", async () => {
        const { app, api } = await fixture();
        const response = deferred();
        const original = api.getMockImplementation();
        api.mockImplementation((path, input) => path === "settings" ? response.promise : original(path, input));
        await userEvent.click($("settings-button"));
        expect($("settings-status").textContent).toBe("Loading settings...");
        app.dispose();
        response.resolve({ theme: "dracula", relativeLineNumbers: true });
        await Promise.resolve();
        await Promise.resolve();
        expect($("settings-status").textContent).toBe("Loading settings...");
        const start = deferred();
        const unmounted = mountApp({ api: () => start.promise });
        mounted.push(unmounted);
        unmounted.dispose();
        start.resolve({});
        await unmounted.ready;
        expect(document.querySelectorAll(".cm-editor")).toHaveLength(0);
    });

    it("ignores a pending agent delivery completion after switching files", async () => {
        const { app, api } = await fixture();
        const response = deferred(), entered = deferred();
        const original = api.getMockImplementation();
        api.mockImplementation((path, input) => {
            if (path === "agent") { entered.resolve(); return response.promise; }
            return original(path, input);
        });
        app.editor.focus();
        await key("{Control>}i{/Control}");
        await expect.poll(() => document.querySelectorAll(".agent-prompt").length).toBe(1);
        await key("send later{Enter}");
        await entered.promise;
        await app.controller.open("/work/b.js");
        expect(document.querySelectorAll(".agent-prompt")).toHaveLength(0);
        response.resolve({});
        await Promise.resolve();
        await Promise.resolve();
        expect($("agent-status").textContent).toBe("");
        expect(app.controller.getState().current.name).toBe("b.js");
    });
});

it("scopes explorer rows to its supplied root and stops late loads after disposal", async () => {
    const first = document.createElement("div"), second = document.createElement("div");
    first.tabIndex = second.tabIndex = 0;
    document.body.append(first, second);
    const makeTree = (tree, path) => createExplorer({
        tree, api: async () => ({ root: "/work", rootName: "work", entries: [{ path, name: path.split("/").pop(), type: "file" }] }),
        onOpen: vi.fn(), onLeave: vi.fn(), onHide: vi.fn(), onError: vi.fn(),
    });
    const a = makeTree(first, "/work/a.md"), b = makeTree(second, "/work/b.md");
    mounted.push(a, b);
    await a.init("/work/a.md"); await b.init("/work/b.md");
    expect(first.querySelector(".tree-row").dataset.path).toBe("/work/a.md");
    expect(second.querySelector(".tree-row").dataset.path).toBe("/work/b.md");
    const pending = deferred();
    const tree = createExplorer({ tree: second, api: () => pending.promise, onError: vi.fn() });
    mounted.push(tree);
    const loading = tree.init("/work/c.md");
    tree.dispose();
    pending.resolve({ root: "/work", rootName: "work", entries: [] });
    await loading;
    expect(second.querySelector(".tree-row").dataset.path).toBe("/work/b.md");
});
