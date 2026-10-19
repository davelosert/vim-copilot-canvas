import { Vim, getCM } from "@replit/codemirror-vim";

const apps = new WeakMap();
let registered = false;
function register() {
    if (registered) return;
    registered = true;
    const action = (name) => (cm, params) => apps.get(cm)?.[name]?.(params);
    Vim.defineEx("AgentSend", "AgentS", action("submitReview"));
    Vim.defineEx("AgentDiscard", "AgentD", action("discardReview"));
    Vim.defineEx("write", "w", (cm, params) => {
        const app = apps.get(cm);
        if (params.argString?.trim()) app?.onError(new Error(":w only saves the current file. Use :e <path> or the explorer to switch files."));
        else app?.save();
    });
    Vim.defineEx("edit", "e", (cm, params) => {
        const path = params.argString?.trim();
        if (path) apps.get(cm)?.open(path);
    });
    Vim.defineEx("Explore", "Ex", action("focusExplorerAfterEx"));
    Vim.defineEx("Lexplore", "Lex", action("toggleExplorerAfterEx"));
    Vim.defineAction("focusExplorer", action("focusExplorer"));
    Vim.unmap("<C-w>", "normal");
    for (const keys of ["<C-w>h", "<C-w><C-h>", "<C-w>w", "<C-w><C-w>"]) {
        Vim.mapCommand(keys, "action", "focusExplorer", {}, { context: "normal" });
    }
}

export function createCommands({ document, editor, agent, actions }) {
    register();
    let attached;
    let disposed = false;
    let timer;
    const delayed = () => { clearTimeout(timer); timer = setTimeout(() => { if (!disposed) actions.focusExplorer(); }); };
    const bindings = {
        ...actions,
        focusExplorerAfterEx: delayed,
        toggleExplorerAfterEx: () => actions.sidebarOpen() ? actions.hideExplorer() : delayed(),
    };
    const keydown = (event) => {
        if (!editor.view) return;
        const inPanel = event.target.closest?.(".agent-prompt");
        if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "i" &&
            editor.view.dom.contains(event.target)) {
            event.preventDefault();
            event.stopPropagation();
            if (!inPanel) agent.open(editor.view);
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key === "Enter" && !inPanel &&
            !event.target.closest?.("dialog")) {
            event.preventDefault();
            event.stopPropagation();
            actions.submitReview();
            return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            actions.save();
        }
    };
    document.addEventListener("keydown", keydown, true);
    return {
        attach() {
            if (attached) apps.delete(attached);
            attached = getCM(editor.view);
            apps.set(attached, bindings);
        },
        dispose() {
            disposed = true;
            clearTimeout(timer);
            if (attached) apps.delete(attached);
            document.removeEventListener("keydown", keydown, true);
        },
    };
}
