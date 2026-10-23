// Vim-style, mouse-friendly file tree. Directories load lazily from /api/tree.
// File operations follow nvim-tree: a create, r rename/move, d delete, x/c/p cut/copy/paste.
export function createExplorer({ tree, api, onOpen, onLeave, onHide, onError,
    onChange = async () => {}, confirm = () => false, prompt, menu }) {
    const nodes = new Map();
    let nextId = 0;
    let clipboard = null;
    let busy = false;
    let dragging = null;
    let closePrompt = null;
    const svgNamespace = "http://www.w3.org/2000/svg";
    let rootPath = null;
    let selected = null;
    let active = null;
    let visible = [];
    let pendingG = false;
    let pendingWindow = false;
    let gTimer;
    let disposed = false;
    const handlers = new AbortController();

    const node = (entry, parent, depth) => {
        const existing = nodes.get(entry.path);
        if (existing) return Object.assign(existing, { parent, depth });
        const value = { ...entry, parent, depth, expanded: false, children: null, loading: false, id: `node-${nextId++}` };
        nodes.set(entry.path, value);
        return value;
    };

    function icon(name, className) {
        const svg = document.createElementNS(svgNamespace, "svg");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.dataset.icon = name;
        svg.setAttribute("class", className);

        const path = document.createElementNS(svgNamespace, "path");
        path.setAttribute("d", {
            chevron: "m6 3.75 4.25 4.25L6 12.25",
            folder: "M1.75 4.75h4l1.5 1.5h7v6.5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z",
            "folder-open": "M1.75 5.25h12.5l-1.2 6.55a1.25 1.25 0 0 1-1.23 1.02H3.2a1.25 1.25 0 0 1-1.23-1.48l.78-4.55",
            file: "M4 1.75h5L12.5 5v9.25a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1Z",
            markdown: "M4 1.75h5L12.5 5v9.25a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1Z",
        }[name]);
        path.setAttribute("fill", name.startsWith("folder") ? "currentColor" : "none");
        path.setAttribute("fill-opacity", "0.12");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("stroke-width", name === "chevron" ? "1.5" : "1.2");
        svg.append(path);

        if (name === "file" || name === "markdown") {
            const lines = document.createElementNS(svgNamespace, "path");
            lines.setAttribute("d", name === "markdown"
                ? "M5 8.75V6.5l1.25 1.25L7.5 6.5v2.25M9 6.5v2.25h1.75M5 11h5.5"
                : "M5.25 8h4.5M5.25 10.25h4.5M5.25 12.5h3");
            lines.setAttribute("fill", "none");
            lines.setAttribute("stroke", "currentColor");
            lines.setAttribute("stroke-linecap", "round");
            lines.setAttribute("stroke-linejoin", "round");
            lines.setAttribute("stroke-width", "1");
            svg.append(lines);
        }

        return svg;
    }

    function fileIconName(item) {
        return /\.(md|markdown|mdown)$/i.test(item.name) ? "markdown" : "file";
    }

    async function load(directory) {
        if (disposed) return;
        directory.loading = true;
        render();
        try {
            const result = await api(`tree?dir=${encodeURIComponent(directory.path)}`);
            if (disposed) return;
            directory.children = result.entries.map((entry) => node(entry, directory, directory.depth + 1));
        } finally {
            directory.loading = false;
        }
    }

    function flatten() {
        visible = [];
        const walk = (children) => {
            for (const child of children ?? []) {
                visible.push(child);
                if (child.type === "directory" && child.expanded) walk(child.children);
            }
        };
        walk(nodes.get(rootPath)?.children);
    }

    function render() {
        if (disposed) return;
        flatten();
        if (selected && !visible.includes(nodes.get(selected))) selected = visible[0]?.path ?? null;
        if (!selected && visible.length) selected = visible[0].path;
        const fragment = document.createDocumentFragment();
        for (const item of visible) {
            const row = document.createElement("div");
            row.className = "tree-row";
            row.id = item.id;
            row.dataset.path = item.path;
            row.setAttribute("role", "treeitem");
            row.setAttribute("aria-level", String(item.depth));
            row.setAttribute("aria-selected", String(item.path === selected));
            if (item.type === "directory") row.setAttribute("aria-expanded", String(item.expanded));
            if (item.loading) row.setAttribute("aria-busy", "true");
            if (item.path === active) row.classList.add("active");
            row.style.paddingLeft = `${8 + (item.depth - 1) * 14}px`;
            row.title = item.path;
            row.draggable = true;
            const clipped = clipboard?.path === item.path;
            if (clipped) row.dataset.clipboard = clipboard.mode;
            const disclosure = document.createElement("span");
            disclosure.className = `tree-disclosure${item.type === "directory" ? " visible" : ""}`;
            if (item.type === "directory") disclosure.append(icon("chevron", "tree-chevron"));
            const fileIcon = icon(
                item.type === "directory" ? (item.expanded ? "folder-open" : "folder") : fileIconName(item),
                `tree-icon ${item.type === "directory" ? "folder-icon" : fileIconName(item) === "markdown" ? "markdown-icon" : "file-icon"}`,
            );
            const label = document.createElement("span");
            label.className = "tree-label";
            label.textContent = item.name;
            row.append(disclosure, fileIcon, label);
            if (clipped) {
                const badge = document.createElement("span");
                badge.className = "tree-badge";
                badge.textContent = clipboard.mode;
                row.append(badge);
            }
            fragment.append(row);
        }
        if (!visible.length) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = rootPath ? "No supported files here." : "Loading…";
            fragment.append(empty);
        }
        tree.replaceChildren(fragment);
        const current = nodes.get(selected);
        if (current) {
            tree.setAttribute("aria-activedescendant", current.id);
            tree.querySelector(`[id="${current.id}"]`)?.scrollIntoView({ block: "nearest" });
        } else {
            tree.removeAttribute("aria-activedescendant");
        }
    }

    function select(path) {
        if (!path) return;
        selected = path;
        render();
    }

    function move(delta) {
        if (!visible.length) return;
        const index = visible.findIndex((item) => item.path === selected);
        const next = Math.max(0, Math.min(visible.length - 1, (index < 0 ? 0 : index) + delta));
        select(visible[next].path);
    }

    async function toggle(directory, expand = !directory.expanded) {
        if (expand && !directory.children) await load(directory);
        if (disposed) return;
        directory.expanded = expand;
        render();
    }

    async function activate(item, { focusEditor = true } = {}) {
        if (!item) return;
        selected = item.path;
        if (item.type === "directory") return toggle(item);
        render();
        await onOpen(item.path, { focusEditor });
    }

    async function right() {
        const item = nodes.get(selected);
        if (!item) return;
        if (item.type === "file") return activate(item);
        if (!item.expanded) return toggle(item, true);
        if (item.children?.length) select(item.children[0].path);
    }

    function left() {
        const item = nodes.get(selected);
        if (!item) return;
        if (item.type === "directory" && item.expanded) return toggle(item, false);
        if (item.parent && item.parent.path !== rootPath) select(item.parent.path);
    }

    async function refresh() {
        if (disposed) return;
        const expanded = [...nodes.values()].filter((item) => item.type === "directory" && item.expanded && item.children);
        const root = nodes.get(rootPath);
        if (!root) return;
        await load(root);
        for (const directory of expanded) {
            if (nodes.get(directory.path) === directory && isAttached(directory)) await load(directory);
        }
        render();
    }

    function isAttached(item) {
        for (let current = item; current; current = current.parent) {
            if (current.path === rootPath) return true;
            if (!current.parent?.children?.includes(current)) return false;
        }
        return false;
    }

    async function expandTo(path) {
        const root = nodes.get(rootPath);
        if (!root || !path?.startsWith(`${rootPath}/`)) return null;
        let directory = root;
        const parts = path.slice(rootPath.length + 1).split("/");
        for (const [index, part] of parts.entries()) {
            if (!directory.children) await load(directory);
            if (disposed) return null;
            const child = directory.children?.find((item) => item.name === part);
            if (!child) return null;
            if (index === parts.length - 1) return child;
            child.expanded = true;
            directory = child;
        }
        return null;
    }

    async function reveal(path) {
        if (disposed) return;
        active = path;
        const found = await expandTo(path);
        if (disposed) return;
        if (found) selected = found.path;
        render();
    }

    const relativePath = (path) => path === rootPath ? "" : path.slice(rootPath.length + 1);
    const joinPath = (directory, name) => directory ? `${directory}/${name}` : name;
    const baseName = (path) => path.split("/").pop();
    const inside = (path, parent) => path === parent || path.startsWith(`${parent}/`);
    const directoryOf = (item) => !item || item.path === rootPath ? nodes.get(rootPath)
        : item.type === "directory" ? item : item.parent ?? nodes.get(rootPath);
    const editable = (item) => item && item.path !== rootPath;

    /** Ask for a root-relative path in the explorer's inline prompt; resolves null when cancelled. */
    function ask(label, value, { selectName = false } = {}) {
        if (!prompt || disposed) return Promise.resolve(null);
        closePrompt?.(null);
        return new Promise((resolve) => {
            const listeners = new AbortController();
            const options = { signal: listeners.signal };
            const finish = (result, { refocus = true } = {}) => {
                listeners.abort();
                closePrompt = null;
                prompt.form.hidden = true;
                if (refocus && !disposed) tree.focus({ preventScroll: true });
                resolve(result);
            };
            closePrompt = (result) => finish(result, { refocus: false });
            prompt.label.textContent = label;
            prompt.input.value = value;
            prompt.form.hidden = false;
            prompt.input.focus();
            const start = value.lastIndexOf("/") + 1;
            const dot = value.lastIndexOf(".");
            if (selectName) prompt.input.setSelectionRange(start, dot > start ? dot : value.length);
            else prompt.input.setSelectionRange(value.length, value.length);
            prompt.form.addEventListener("submit", (event) => {
                event.preventDefault();
                finish(prompt.input.value.trim() || null);
            }, options);
            prompt.input.addEventListener("keydown", (event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                    event.preventDefault();
                    finish(null);
                }
            }, options);
            prompt.input.addEventListener("blur", () => finish(null, { refocus: false }), options);
        });
    }

    function forget(path) {
        for (const key of [...nodes.keys()]) if (key !== rootPath && inside(key, path)) nodes.delete(key);
        if (clipboard && inside(clipboard.path, path)) clipboard = null;
    }

    // Collapsed folders may be stale after an operation; drop their cache so they reload on expand.
    async function changed(path) {
        for (const item of nodes.values()) {
            if (item.type === "directory" && !item.expanded && item.path !== rootPath) item.children = null;
        }
        await refresh();
        if (disposed || !path) return;
        const found = await expandTo(path);
        if (disposed) return;
        if (found) selected = found.path;
        render();
    }

    async function exclusive(operation) {
        if (busy || disposed || !rootPath) return;
        busy = true;
        try { await operation(); } finally { busy = false; }
    }

    async function create(type, item = nodes.get(selected)) {
        const directory = relativePath(directoryOf(item).path);
        const prefix = directory ? `${directory}/` : "";
        const label = type === "directory" ? "New folder" : type === "file" ? "New file" : "New file (end with / for a folder)";
        const value = await ask(label, prefix);
        if (!value || value === prefix) return;
        const result = await api("files/create", {
            path: value.replace(/\/+$/, ""),
            type: type ?? (value.endsWith("/") ? "directory" : "file"),
        });
        await changed(result.path);
        await onChange({ action: "create", ...result });
    }

    async function moved(path, result) {
        forget(path);
        await changed(result.path);
        await onChange({ action: "move", ...result });
    }

    async function rename(item = nodes.get(selected)) {
        if (!editable(item)) return;
        const from = relativePath(item.path);
        const value = await ask("Rename / move to", from, { selectName: true });
        if (!value || value.replace(/\/+$/, "") === from) return;
        await moved(item.path, await api("files/move", { from: item.path, to: value.replace(/\/+$/, "") }));
    }

    async function remove(item = nodes.get(selected)) {
        if (!editable(item)) return;
        const what = item.type === "directory" ? `the folder ${relativePath(item.path)} and everything in it` : relativePath(item.path);
        if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
        const index = visible.indexOf(item);
        const result = await api("files/delete", { path: item.path });
        forget(item.path);
        selected = null;
        await changed();
        if (disposed) return;
        selected = visible[Math.max(0, Math.min(index, visible.length - 1))]?.path ?? null;
        render();
        await onChange({ action: "delete", ...result });
    }

    function yank(mode, item = nodes.get(selected)) {
        if (!editable(item)) return;
        clipboard = clipboard?.path === item.path && clipboard.mode === mode ? null : { path: item.path, mode };
        render();
    }

    async function transfer(path, directory, operation) {
        let to = joinPath(relativePath(directory.path), baseName(path));
        if (operation === "move" && to === relativePath(path)) return;
        for (;;) {
            let result;
            try {
                result = await api(`files/${operation}`, { from: path, to });
            } catch (error) {
                if (error.code !== "already_exists") throw error;
                const value = await ask(`${baseName(to)} already exists. ${operation === "move" ? "Move" : "Copy"} as`, to, { selectName: true });
                if (!value || value === to) return;
                to = value.replace(/\/+$/, "");
                continue;
            }
            if (operation === "move") return moved(path, result);
            await changed(result.path);
            return onChange({ action: "copy", ...result });
        }
    }

    async function paste(item = nodes.get(selected)) {
        if (!clipboard) return;
        const { path, mode } = clipboard;
        await transfer(path, directoryOf(item), mode === "cut" ? "move" : "copy");
    }

    const operations = {
        "new-file": (item) => create("file", item), "new-folder": (item) => create("directory", item),
        rename, delete: remove, paste,
        cut: (item) => yank("cut", item), copy: (item) => yank("copy", item),
    };
    const perform = (name, item) => run(exclusive(() => operations[name](item)));

    async function init(activePath) {
        if (disposed) return;
        const result = await api("tree");
        if (disposed) return result;
        rootPath = result.root;
        const root = node({ name: result.rootName, path: result.root, type: "directory" }, null, 0);
        root.expanded = true;
        root.children = result.entries.map((entry) => node(entry, root, 1));
        render();
        await reveal(activePath);
        return result;
    }

    const run = (promise) => Promise.resolve(promise).catch((error) => { if (!disposed) onError(error); });

    tree.addEventListener("keydown", (event) => {
        if (event.metaKey || event.altKey) return;
        const key = event.key;
        if (pendingWindow) {
            pendingWindow = false;
            event.preventDefault();
            if (["l", "w", "p", "ArrowRight"].includes(key) || (event.ctrlKey && key === "w")) onLeave();
            return;
        }
        if (event.ctrlKey) {
            const half = Math.max(1, Math.floor(tree.clientHeight / 28 / 2));
            const actions = { w: () => { pendingWindow = true; }, d: () => move(half), u: () => move(-half), n: () => move(1), p: () => move(-1) };
            if (actions[key]) { event.preventDefault(); actions[key](); }
            return;
        }
        const wasG = pendingG;
        pendingG = false;
        clearTimeout(gTimer);
        const actions = {
            j: () => move(1), ArrowDown: () => move(1),
            k: () => move(-1), ArrowUp: () => move(-1),
            l: () => run(right()), ArrowRight: () => run(right()),
            h: left, ArrowLeft: left,
            Enter: () => run(activate(nodes.get(selected))),
            o: () => run(activate(nodes.get(selected))),
            " ": () => run(activate(nodes.get(selected), { focusEditor: false })),
            G: () => select(visible.at(-1)?.path),
            Home: () => select(visible[0]?.path), End: () => select(visible.at(-1)?.path),
            g: () => {
                if (wasG) return select(visible[0]?.path);
                pendingG = true;
                gTimer = setTimeout(() => { pendingG = false; }, 800);
            },
            R: () => run(refresh()),
            a: () => run(exclusive(() => create())),
            r: () => perform("rename"),
            d: () => perform("delete"),
            x: () => perform("cut"),
            c: () => perform("copy"),
            p: () => perform("paste"),
            "-": () => select(nodes.get(selected)?.parent?.path !== rootPath ? nodes.get(selected)?.parent?.path : selected),
            Escape: onLeave,
            q: onHide,
        };
        if (actions[key]) {
            event.preventDefault();
            event.stopPropagation();
            actions[key]();
        }
    }, { signal: handlers.signal });

    tree.addEventListener("click", (event) => {
        const row = event.target.closest(".tree-row");
        if (!row) return;
        const item = nodes.get(row.dataset.path);
        // Rows are re-rendered on click, so the browser's dblclick event never fires; use the click count.
        const double = event.detail >= 2 && item?.type === "file";
        if (!double) tree.focus({ preventScroll: true });
        run(activate(item, { focusEditor: double }));
    }, { signal: handlers.signal });

    let menuTarget = null;
    function closeMenu({ refocus = false } = {}) {
        if (!menu || menu.hidden) return;
        menu.hidden = true;
        menuTarget = null;
        if (refocus) tree.focus({ preventScroll: true });
    }

    function openMenu(item, x, y) {
        menuTarget = item;
        for (const button of menu.querySelectorAll("button[data-action]")) {
            const action = button.dataset.action;
            button.hidden = !editable(item) && ["rename", "delete", "cut", "copy"].includes(action);
            button.disabled = action === "paste" && !clipboard;
        }
        menu.hidden = false;
        const { innerWidth, innerHeight } = tree.ownerDocument.defaultView;
        menu.style.left = `${Math.max(0, Math.min(x, innerWidth - menu.offsetWidth))}px`;
        menu.style.top = `${Math.max(0, Math.min(y, innerHeight - menu.offsetHeight))}px`;
        menu.querySelector("button:not([hidden]):not(:disabled)")?.focus();
    }

    if (menu) {
        tree.addEventListener("contextmenu", (event) => {
            if (!rootPath) return;
            event.preventDefault();
            const row = event.target.closest?.(".tree-row");
            const item = row ? nodes.get(row.dataset.path) : nodes.get(rootPath);
            if (row) select(item.path);
            let { clientX: x, clientY: y } = event;
            // Keyboard-invoked menus (Shift+F10, Menu key) have no pointer position.
            if (!x && !y) {
                const rect = (tree.querySelector(`[id="${nodes.get(selected)?.id}"]`) ?? tree).getBoundingClientRect();
                x = rect.left + 16;
                y = rect.bottom;
            }
            openMenu(item, x, y);
        }, { signal: handlers.signal });
        menu.addEventListener("click", (event) => {
            const button = event.target.closest?.("button[data-action]");
            if (!button || button.disabled) return;
            const item = menuTarget;
            closeMenu({ refocus: true });
            perform(button.dataset.action, item);
        }, { signal: handlers.signal });
        menu.addEventListener("keydown", (event) => {
            const buttons = [...menu.querySelectorAll("button[data-action]:not([hidden]):not(:disabled)")];
            const index = buttons.indexOf(event.target);
            const next = { ArrowDown: index + 1, j: index + 1, ArrowUp: index - 1, k: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
            if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu({ refocus: true });
            } else if (next !== undefined && buttons.length) {
                event.preventDefault();
                buttons[(next + buttons.length) % buttons.length].focus();
            }
        }, { signal: handlers.signal });
        tree.ownerDocument.addEventListener("pointerdown", (event) => {
            if (!menu.contains(event.target)) closeMenu();
        }, { signal: handlers.signal, capture: true });
        menu.addEventListener("focusout", (event) => {
            if (!menu.contains(event.relatedTarget)) closeMenu();
        }, { signal: handlers.signal });
    }

    const dropTarget = (event) => {
        if (!dragging) return null;
        const row = event.target.closest?.(".tree-row");
        const directory = directoryOf(row ? nodes.get(row.dataset.path) : null);
        if (!directory || inside(directory.path, dragging) || nodes.get(dragging)?.parent === directory) return null;
        return directory;
    };
    const highlightDrop = (directory) => {
        for (const element of tree.querySelectorAll(".drop-target")) element.classList.remove("drop-target");
        tree.classList.toggle("drop-root", directory?.path === rootPath);
        if (directory && directory.path !== rootPath) tree.querySelector(`[id="${directory.id}"]`)?.classList.add("drop-target");
    };
    tree.addEventListener("dragstart", (event) => {
        const row = event.target.closest?.(".tree-row");
        if (!row || busy) return event.preventDefault();
        dragging = row.dataset.path;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", relativePath(dragging));
    }, { signal: handlers.signal });
    tree.addEventListener("dragover", (event) => {
        const directory = dropTarget(event);
        highlightDrop(directory);
        if (!directory) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
    }, { signal: handlers.signal });
    tree.addEventListener("dragleave", (event) => {
        if (!tree.contains(event.relatedTarget)) highlightDrop(null);
    }, { signal: handlers.signal });
    tree.addEventListener("drop", (event) => {
        const directory = dropTarget(event);
        const source = dragging;
        dragging = null;
        highlightDrop(null);
        if (!directory) return;
        event.preventDefault();
        run(exclusive(() => transfer(source, directory, "move")));
    }, { signal: handlers.signal });
    tree.addEventListener("dragend", () => { dragging = null; highlightDrop(null); }, { signal: handlers.signal });

    return {
        init, reveal,
        createFile: () => perform("new-file"),
        createFolder: () => perform("new-folder"),
        refresh: () => run(refresh()),
        collapseAll() {
            for (const item of nodes.values()) if (item.path !== rootPath) item.expanded = false;
            render();
        },
        focus() {
            if (disposed) return;
            if (!selected && visible.length) select(visible[0].path);
            tree.focus({ preventScroll: true });
        },
        dispose() {
            disposed = true;
            clearTimeout(gTimer);
            closePrompt?.(null);
            closeMenu();
            handlers.abort();
            nodes.clear();
        },
    };
}
