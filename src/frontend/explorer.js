// Vim-style, mouse-friendly file tree. Directories load lazily from /api/tree.
export function createExplorer({ tree, api, onOpen, onLeave, onHide, onFind = () => {}, onError }) {
    const nodes = new Map();
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
        const value = { ...entry, parent, depth, expanded: false, children: null, loading: false, id: `node-${nodes.size}` };
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

    async function reveal(path) {
        if (disposed) return;
        active = path;
        const root = nodes.get(rootPath);
        if (!root || !path?.startsWith(`${rootPath}/`)) return render();
        let directory = root;
        const parts = path.slice(rootPath.length + 1).split("/");
        for (const [index, part] of parts.entries()) {
            if (!directory.children) await load(directory);
            if (disposed) return;
            const child = directory.children?.find((item) => item.name === part);
            if (!child) break;
            if (index === parts.length - 1) { selected = child.path; break; }
            child.expanded = true;
            directory = child;
        }
        render();
    }

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
            f: onFind,
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

    return {
        init, reveal,
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
        dispose() { disposed = true; clearTimeout(gTimer); handlers.abort(); nodes.clear(); },
    };
}
