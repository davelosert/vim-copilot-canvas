import { rank } from "../shared/fuzzy.js";

const LIMIT = 200;
const DEBOUNCE_ABOVE = 5000;

/**
 * Quick-open modal: fuzzy-search every workspace file (from /api/files) and open one.
 * Keys are handled on the dialog, which sits outside the editor, so codemirror-vim never sees them.
 */
export function createFinder({ elements: { dialog, input, list, status }, api, onOpen, onError, window: win }) {
    const doc = dialog.ownerDocument;
    const handlers = new AbortController();
    const listen = (element, type, fn, options) => element.addEventListener(type, fn, { signal: handlers.signal, ...options });
    let listing = null;
    let results = [];
    let selected = 0;
    let generation = 0;
    let restore = null;
    let timer;
    let disposed = false;

    const highlight = (parent, text, offset, positions) => {
        let plain = "";
        const flush = () => { if (plain) parent.append(plain); plain = ""; };
        for (let index = 0; index < text.length; index++) {
            if (positions.has(index + offset)) {
                flush();
                const mark = doc.createElement("mark");
                mark.textContent = text[index];
                parent.append(mark);
            } else plain += text[index];
        }
        flush();
    };
    const option = (id) => `finder-option-${id}`;
    const describe = () => {
        if (!listing) return "Loading files...";
        const total = listing.files.length;
        if (!input.value.trim()) return `${total} file${total === 1 ? "" : "s"}${listing.truncated ? " (list truncated)" : ""}`;
        if (!results.length) return "No matching files";
        return `${results.length >= LIMIT ? `Top ${LIMIT}` : results.length} of ${total} files`;
    };
    const select = (index, { scroll = true } = {}) => {
        if (!results.length) {
            selected = 0;
            input.removeAttribute("aria-activedescendant");
            return;
        }
        selected = (index + results.length) % results.length;
        for (const row of list.children) row.setAttribute("aria-selected", String(Number(row.dataset.index) === selected));
        input.setAttribute("aria-activedescendant", option(selected));
        if (scroll) list.children[selected]?.scrollIntoView?.({ block: "nearest" });
    };
    const render = () => {
        const rows = results.map((result, index) => {
            const row = doc.createElement("li");
            row.id = option(index);
            row.className = "finder-option";
            row.setAttribute("role", "option");
            row.dataset.index = String(index);
            row.dataset.path = result.path;
            const base = result.path.lastIndexOf("/") + 1;
            const positions = new Set(result.positions);
            const name = doc.createElement("span");
            name.className = "finder-name";
            highlight(name, result.path.slice(base), base, positions);
            const directory = doc.createElement("span");
            directory.className = "finder-dir";
            highlight(directory, result.path.slice(0, Math.max(0, base - 1)), 0, positions);
            row.append(name, directory);
            if (result.recent && !input.value.trim()) {
                const badge = doc.createElement("span");
                badge.className = "finder-recent";
                badge.textContent = "recent";
                row.append(badge);
            }
            return row;
        });
        list.replaceChildren(...rows);
        status.textContent = describe();
        select(0);
    };
    const update = () => {
        clearTimeout(timer);
        timer = undefined;
        results = listing ? rank(input.value, listing.files, { recent: listing.recent, limit: LIMIT }) : [];
        render();
    };
    const close = () => { if (dialog.open) dialog.close(); };
    const choose = (index = selected) => {
        const result = results[index];
        if (!result || !listing) return;
        const path = listing.root + listing.separator + result.path.split("/").join(listing.separator);
        restore = null;
        close();
        onOpen(path);
    };
    const keys = (event) => {
        if (event.isComposing) return;
        const control = event.ctrlKey && !event.metaKey && !event.altKey;
        const key = event.key.toLowerCase();
        let action;
        if (event.key === "ArrowDown" || (control && (key === "n" || key === "j"))) action = () => select(selected + 1);
        else if (event.key === "ArrowUp" || (control && (key === "p" || key === "k"))) action = () => select(selected - 1);
        else if (event.metaKey && !event.ctrlKey && key === "p") action = () => select(selected + 1);
        else if (event.key === "PageDown") action = () => select(Math.min(results.length - 1, selected + 10));
        else if (event.key === "PageUp") action = () => select(Math.max(0, selected - 10));
        else if (event.key === "Enter") action = () => { if (timer) update(); choose(); };
        else if (event.key === "Escape") action = close;
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        action();
    };

    listen(dialog, "keydown", keys);
    listen(input, "input", () => {
        clearTimeout(timer);
        timer = undefined;
        if ((listing?.files.length ?? 0) > DEBOUNCE_ABOVE) timer = win.setTimeout(() => { timer = undefined; update(); }, 60);
        else update();
    });
    // Keep focus in the input so typing continues after a click on the list.
    listen(list, "mousedown", (event) => event.preventDefault());
    listen(list, "click", (event) => {
        const row = event.target.closest?.(".finder-option");
        if (row) choose(Number(row.dataset.index));
    });
    listen(list, "mousemove", (event) => {
        const row = event.target.closest?.(".finder-option");
        if (row && Number(row.dataset.index) !== selected) select(Number(row.dataset.index), { scroll: false });
    });
    listen(dialog, "click", (event) => { if (event.target === dialog) close(); });
    listen(dialog, "cancel", (event) => { event.preventDefault(); close(); });
    listen(dialog, "close", () => {
        generation++;
        clearTimeout(timer);
        timer = undefined;
        const target = restore;
        restore = null;
        if (!disposed && target?.isConnected) target.focus?.();
    });

    return {
        isOpen: () => dialog.open,
        open() {
            if (disposed) return;
            if (dialog.open) { input.select(); return; }
            restore = doc.activeElement;
            input.value = "";
            dialog.showModal();
            input.focus();
            update();
            const current = ++generation;
            api("files").then((value) => {
                if (disposed || current !== generation) return;
                listing = value;
                update();
            }, (error) => {
                if (disposed || current !== generation) return;
                status.textContent = "Could not list files";
                onError(error);
            });
        },
        close,
        dispose() {
            disposed = true;
            clearTimeout(timer);
            handlers.abort();
            close();
        },
    };
}
