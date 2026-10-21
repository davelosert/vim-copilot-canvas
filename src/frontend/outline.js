import { markdownLanguage } from "@codemirror/lang-markdown";
import { isMarkdown, renderMarkdown } from "./markdown.js";

export function createOutline({ list, name, getDocument, onJump, onLeave, onHide, visible = true }) {
    const doc = list.ownerDocument;
    const handlers = new AbortController();
    let filename = "", headings = [], selected = 0, cursorLine = 1;
    let timer, gTimer, pendingG = false, pendingWindow = false;
    let dirty = true, renderedSelected = -1, renderedActive = -1;

    function selection({ scroll = false } = {}) {
        let active = -1;
        for (const [index, heading] of headings.entries()) {
            if (heading.line > cursorLine) break;
            active = index;
        }
        for (const index of new Set([renderedSelected, renderedActive, selected, active])) {
            const row = headings[index] && list.children[index];
            if (!row) continue;
            row.setAttribute("aria-selected", String(index === selected));
            row.classList.toggle("active", index === active);
            if (index === active) row.setAttribute("aria-current", "location");
            else row.removeAttribute("aria-current");
        }
        renderedSelected = selected;
        renderedActive = active;
        const row = headings.length ? list.children[selected] : null;
        if (row) {
            list.setAttribute("aria-activedescendant", row.id);
            if (scroll) row.scrollIntoView({ block: "nearest" });
        } else list.removeAttribute("aria-activedescendant");
    }

    function render() {
        clearTimeout(timer);
        if (!visible) return;
        dirty = false;
        const text = getDocument();
        const source = text?.toString() ?? "";
        headings = [];
        if (isMarkdown(filename)) {
            markdownLanguage.parser.parse(source).iterate({
                enter(node) {
                    const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
                    if (!match) return;
                    const label = doc.createElement("div");
                    label.innerHTML = renderMarkdown(source.slice(node.from, node.to));
                    headings.push({
                        level: Number(match[1]), line: text.lineAt(node.from).number,
                        label: label.textContent.trim() || "(Untitled heading)",
                    });
                    return false;
                },
            });
        }
        selected = doc.activeElement === list
            ? Math.min(selected, Math.max(0, headings.length - 1))
            : Math.max(0, headings.findLastIndex((heading) => heading.line <= cursorLine));
        const fragment = doc.createDocumentFragment();
        for (const [index, heading] of headings.entries()) {
            const row = doc.createElement("div");
            row.id = `${list.id}-heading-${index}`;
            row.className = "outline-row";
            row.dataset.index = String(index);
            row.dataset.line = String(heading.line);
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", "false");
            row.style.paddingLeft = `${8 + (heading.level - 1) * 14}px`;
            row.title = `${heading.label} (line ${heading.line})`;
            const level = doc.createElement("span");
            level.className = "outline-level";
            level.setAttribute("aria-hidden", "true");
            level.textContent = `H${heading.level}`;
            const label = doc.createElement("span");
            label.className = "tree-label";
            label.textContent = heading.label;
            row.append(level, label);
            fragment.append(row);
        }
        if (!headings.length) {
            const empty = doc.createElement("div");
            empty.className = "tree-empty";
            empty.textContent = isMarkdown(filename) ? "No headings in this document." : "Outline is available for Markdown files.";
            fragment.append(empty);
        }
        list.replaceChildren(fragment);
        renderedSelected = renderedActive = -1;
        selection();
    }

    function move(index) {
        selected = Math.max(0, Math.min(headings.length - 1, index));
        selection({ scroll: true });
    }

    function jump(focusEditor = true) {
        if (headings[selected]) onJump(headings[selected].line, { focusEditor });
        if (!focusEditor) list.focus({ preventScroll: true });
    }

    list.addEventListener("click", (event) => {
        const row = event.target.closest(".outline-row");
        if (!row) return;
        move(Number(row.dataset.index));
        jump();
    }, { signal: handlers.signal });
    list.addEventListener("keydown", (event) => {
        if (event.metaKey || event.altKey) return;
        const key = event.key;
        if (pendingWindow) {
            pendingWindow = false;
            event.preventDefault();
            if (["l", "w", "p", "ArrowRight"].includes(key)) onLeave();
            return;
        }
        const wasG = pendingG;
        pendingG = false;
        clearTimeout(gTimer);
        const half = Math.max(1, Math.floor(list.clientHeight / 28 / 2));
        const actions = event.ctrlKey ? {
            w: () => { pendingWindow = true; },
            d: () => move(selected + half), u: () => move(selected - half),
            n: () => move(selected + 1), p: () => move(selected - 1),
        } : {
            j: () => move(selected + 1), ArrowDown: () => move(selected + 1),
            k: () => move(selected - 1), ArrowUp: () => move(selected - 1),
            Enter: () => jump(), l: () => jump(), ArrowRight: () => jump(), o: () => jump(),
            " ": () => jump(false), Escape: onLeave, q: onHide,
            G: () => move(headings.length - 1), End: () => move(headings.length - 1),
            Home: () => move(0),
            g: () => {
                if (wasG) return move(0);
                pendingG = true;
                gTimer = setTimeout(() => { pendingG = false; }, 800);
            },
        };
        if (actions[key]) {
            event.preventDefault();
            event.stopPropagation();
            actions[key]();
        }
    }, { signal: handlers.signal });

    return {
        document(snapshot) {
            filename = snapshot.name;
            name.textContent = name.title = filename;
            selected = 0;
            dirty = true;
            render();
        },
        edited() { dirty = true; clearTimeout(timer); if (visible) timer = setTimeout(render, 100); },
        setVisible(value) {
            visible = value;
            if (!visible) clearTimeout(timer);
            else if (dirty) render();
            else {
                if (doc.activeElement !== list) selected = Math.max(0, headings.findLastIndex((heading) => heading.line <= cursorLine));
                selection();
            }
        },
        cursor({ line }) {
            cursorLine = line;
            if (!visible) return;
            if (doc.activeElement !== list) {
                selected = Math.max(0, headings.findLastIndex((heading) => heading.line <= line));
            }
            selection();
        },
        focus() { list.focus({ preventScroll: true }); selection({ scroll: true }); },
        dispose() { clearTimeout(timer); clearTimeout(gTimer); handlers.abort(); },
    };
}
