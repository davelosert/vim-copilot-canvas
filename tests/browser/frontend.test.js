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
    let settings = { relativeLineNumbers: false, theme: "system" };
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
        await expect.poll(() => $("settings-status").textContent).toBe("Settings saved.");
        await userEvent.selectOptions($("editor-theme"), "dracula");
        await expect.poll(() => $("settings-status").textContent).toBe("Settings saved.");
        expect(app.editor.readText()).toBe(content);
        expect(app.editor.view.state.selection.main.head).toBe(selection);
        await userEvent.click($("close-settings"));
        app.editor.focus();
        await key("u");
        await expect.poll(() => app.editor.readText()).toBe("# Title\n\nfirst line\nsecond line");
        expect(api.mock.calls.some(([path, input]) => path === "settings" && input?.relativeLineNumbers)).toBe(true);
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
