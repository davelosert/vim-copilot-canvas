// Vim-style, mouse-friendly file tree. Directories load lazily from /api/tree.
export function createExplorer({ tree, api, onOpen, onLeave, onHide, onError }) {
    const nodes = new Map();
    let rootPath = null;
    let selected = null;
    let active = null;
    let visible = [];
    let pendingG = false;
    let pendingWindow = false;
    let gTimer;

    const node = (entry, parent, depth) => {
        const existing = nodes.get(entry.path);
        if (existing) return Object.assign(existing, { parent, depth });
        const value = { ...entry, parent, depth, expanded: false, children: null, loading: false, id: `node-${nodes.size}` };
        nodes.set(entry.path, value);
        return value;
    };

    async function load(directory) {
        directory.loading = true;
        render();
        try {
            const result = await api(`tree?dir=${encodeURIComponent(directory.path)}`);
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
            if (item.path === active) row.classList.add("active");
            row.style.paddingLeft = `${8 + (item.depth - 1) * 14}px`;
            row.title = item.path;
            const icon = document.createElement("span");
            icon.className = `tree-icon ${item.type}`;
            icon.textContent = item.type === "directory" ? (item.loading ? "…" : item.expanded ? "▾" : "▸") : "";
            const label = document.createElement("span");
            label.className = "tree-label";
            label.textContent = item.name;
            row.append(icon, label);
            fragment.append(row);
        }
        if (!visible.length) {
            const empty = document.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = rootPath ? "No Markdown files here." : "Loading…";
            fragment.append(empty);
        }
        tree.replaceChildren(fragment);
        const current = nodes.get(selected);
        if (current) {
            tree.setAttribute("aria-activedescendant", current.id);
            document.getElementById(current.id)?.scrollIntoView({ block: "nearest" });
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
        active = path;
        const root = nodes.get(rootPath);
        if (!root || !path?.startsWith(`${rootPath}/`)) return render();
        let directory = root;
        const parts = path.slice(rootPath.length + 1).split("/");
        for (const [index, part] of parts.entries()) {
            if (!directory.children) await load(directory);
            const child = directory.children.find((item) => item.name === part);
            if (!child) break;
            if (index === parts.length - 1) { selected = child.path; break; }
            child.expanded = true;
            directory = child;
        }
        render();
    }

    async function init(activePath) {
        const result = await api("tree");
        rootPath = result.root;
        const root = node({ name: result.rootName, path: result.root, type: "directory" }, null, 0);
        root.expanded = true;
        root.children = result.entries.map((entry) => node(entry, root, 1));
        render();
        await reveal(activePath);
        return result;
    }

    const run = (promise) => Promise.resolve(promise).catch(onError);

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
            "-": () => select(nodes.get(selected)?.parent?.path !== rootPath ? nodes.get(selected)?.parent?.path : selected),
            Escape: onLeave,
            q: onHide,
        };
        if (actions[key]) {
            event.preventDefault();
            event.stopPropagation();
            actions[key]();
        }
    });

    tree.addEventListener("click", (event) => {
        const row = event.target.closest(".tree-row");
        if (!row) return;
        const item = nodes.get(row.dataset.path);
        // Rows are re-rendered on click, so the browser's dblclick event never fires; use the click count.
        const double = event.detail >= 2 && item?.type === "file";
        if (!double) tree.focus({ preventScroll: true });
        run(activate(item, { focusEditor: double }));
    });

    return {
        init, reveal,
        refresh: () => run(refresh()),
        collapseAll() {
            for (const item of nodes.values()) if (item.path !== rootPath) item.expanded = false;
            render();
        },
        focus() {
            if (!selected && visible.length) select(visible[0].path);
            tree.focus({ preventScroll: true });
        },
    };
}
