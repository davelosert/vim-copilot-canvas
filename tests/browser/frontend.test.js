import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountApp } from "../../src/frontend/app.js";
import { createExplorer } from "../../src/frontend/explorer.js";

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

async function fixture(options = {}) {
    const body = new DOMParser().parseFromString(markup, "text/html").body;
    document.body.innerHTML = body.innerHTML;
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
async function insert(app, text) {
    app.editor.focus();
    await key("i");
    await key(text);
    await key("{Escape}");
    await expect.poll(() => app.controller.getState().dirty).toBe(false);
}

describe("mounted frontend with real CodeMirror", () => {
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
        expect(app.editor.readText()).toBe(content);
        expect(app.editor.view.state.selection.main.head).toBe(selection);
        await userEvent.click($("close-settings"));
        app.editor.focus();
        await key("u");
        await expect.poll(() => app.editor.readText()).toBe("# Title\n\nfirst line\nsecond line");
        expect(api.mock.calls.some(([path, input]) => path === "settings" && input?.relativeLineNumbers)).toBe(true);
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
        expect(getComputedStyle(document.querySelector(".agent-hint")).display).toBe("none");
        expect(getComputedStyle($("help").querySelector(".shortcut-section")).display).toBe("none");

        await userEvent.click($("show-keyboard-shortcut-indicators"));
        expect($("settings-status").textContent).toBe("");
        expect(document.documentElement.dataset.showKeyboardShortcutIndicators).toBe("true");
        expect(getComputedStyle(document.querySelector(".agent-actions kbd")).display).not.toBe("none");
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
            expect($("settings").getBoundingClientRect().height).toBe(before.height);
            expect(app.editor.view.state).toBe(state);
            expect(dispatch).not.toHaveBeenCalled();
            expect(repaint).not.toHaveBeenCalled();
            expect(disabledChanges).toHaveLength(0);

            api.mockImplementation(original);
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
        const saved = await original("settings");
        api.mockClear();
        const content = app.editor.readText();
        const selection = app.editor.view.state.selection;
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
        expect(send.classList.contains("primary")).toBe(true);
        expect(send.querySelector("kbd").textContent).toMatch(/⏎|Enter/);
        expect(getComputedStyle(send.querySelector("kbd")).display).not.toBe("none");
        expect(send.getAttribute("aria-keyshortcuts")).toBe("Enter");
        expect(prompt.querySelector(".agent-hint kbd").textContent).toMatch(/⇧⏎|Shift\+Enter/);
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
        expect($("save-status").textContent).toBe("Saved to disk");
    });

    it("does not count server replacements as local edits and gates typing throughout reload", async () => {
        const { app, api } = await fixture();
        const original = api.getMockImplementation();
        const server = { ...app.controller.getState().current, content: "# External\n\nDisk version", revision: "external", conflict: true };
        const response = deferred(), entered = deferred();
        api.mockImplementation((path, input) => {
            if (path.startsWith("document")) return Promise.resolve({ ...server });
            if (path === "reload") { entered.resolve(input); return response.promise; }
            return original(path, input);
        });
        await app.controller.poll();
        expect(app.editor.readText()).toBe(server.content);
        expect(app.controller.getState()).toMatchObject({ localVersion: 0, persistedVersion: 0, localPending: false });
        expect(api.mock.calls.filter(([path]) => path === "draft")).toHaveLength(0);
        await userEvent.click($("reload-button"));
        await entered.promise;
        expect(app.editor.view.state.readOnly).toBe(true);
        expect(app.editor.view.contentDOM.contentEditable).toBe("false");
        const before = app.editor.readText();
        app.editor.focus();
        await key("i");
        await key("must not insert");
        await key("{Escape}");
        expect(app.editor.readText()).toBe(before);
        response.resolve({ ...server, content: "# Reloaded", conflict: false, revision: "reloaded" });
        await expect.poll(() => app.editor.readText()).toBe("# Reloaded");
        await expect.poll(() => app.editor.view.state.readOnly).toBe(false);
        expect(app.controller.getState()).toMatchObject({ localVersion: 0, persistedVersion: 0, blocked: false });
        await insert(app, "allowed ");
        expect(app.editor.readText()).toContain("allowed ");
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
