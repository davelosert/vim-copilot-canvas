import { EditorSelection, Prec, StateEffect } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView, RectangleMarker, ViewPlugin, layer } from "@codemirror/view";

const normalizeLabel = (text) => text.slice(1, -1).trim().replace(/\s+/g, " ").toLowerCase();

export function markdownLinkAt(state, position) {
    const tree = syntaxTree(state);
    let node = tree.resolveInner(position, 1);
    while (node && !["URL", "Link", "Autolink"].includes(node.name)) node = node.parent;
    if (!node || position >= node.to) return null;
    const range = node;
    let url = node.name === "URL" ? node : node.getChild("URL");
    if (!url && node.name === "Link") {
        const label = node.getChild("LinkLabel");
        const key = label && label.to - label.from > 2
            ? normalizeLabel(state.sliceDoc(label.from, label.to))
            : normalizeLabel(state.sliceDoc(node.from, label?.from ?? node.to));
        tree.iterate({
            enter(reference) {
                if (reference.name !== "LinkReference" || url) return;
                const definition = reference.node.getChild("LinkLabel");
                if (definition && normalizeLabel(state.sliceDoc(definition.from, definition.to)) === key) {
                    url = reference.node.getChild("URL");
                }
            },
        });
    }
    if (!url) return null;
    let href = state.sliceDoc(url.from, url.to);
    if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
    href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
    if (!/^https?:\/\//i.test(href)) return null;
    try {
        const parsed = new URL(href);
        if (!parsed.hostname) return null;
    } catch { return null; }
    return { from: range.from, to: range.to, href };
}
const linkChanged = StateEffect.define();

export function markdownLinks() {
    const plugin = ViewPlugin.fromClass(class {
        constructor(view) {
            this.view = view;
            this.window = view.dom.ownerDocument.defaultView;
            const navigator = this.window.navigator;
            this.mac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
            this.pointer = null;
            this.link = null;
            this.modifierHeld = false;
            this.key = (event) => {
                this.modifierHeld = this.mac ? event.metaKey : event.ctrlKey;
                this.hover(event);
            };
            this.move = (event) => {
                if (!view.contentDOM.contains(event.target)) return;
                this.pointer = { x: event.clientX, y: event.clientY };
                this.hover(event);
            };
            this.leave = () => this.clear();
            this.blur = () => { this.modifierHeld = false; this.clear(); };
            for (const type of ["pointermove", "pointerover"]) view.contentDOM.addEventListener(type, this.move);
            view.contentDOM.addEventListener("pointerleave", this.leave);
            this.window.addEventListener("keydown", this.key);
            this.window.addEventListener("keyup", this.key);
            this.window.addEventListener("blur", this.blur);
        }
        modified(event) {
            return (this.modifierHeld || (this.mac ? event.metaKey : event.ctrlKey)) && !event.altKey && !event.shiftKey;
        }
        atPointer(event) {
            if (!this.modified(event) || !this.pointer) return null;
            const position = this.view.posAtCoords(this.pointer);
            return position === null ? null : markdownLinkAt(this.view.state, position);
        }
        hover(event) {
            this.set(this.atPointer(event));
        }
        clear() {
            this.pointer = null;
            this.set(null);
        }
        set(link) {
            if (link?.from === this.link?.from && link?.to === this.link?.to && link?.href === this.link?.href) return;
            this.link = link;
            // Change only the root class and a separate layer so the text nodes under the pointer stay intact.
            this.view.dom.classList.toggle("cm-open-link-active", Boolean(link));
            if (link) this.view.dom.title = `${this.mac ? "Cmd" : "Ctrl"}+click to open ${link.href}`;
            else this.view.dom.removeAttribute("title");
            this.view.dispatch({ effects: linkChanged.of(null) });
        }
        update(update) {
            if ((update.docChanged || update.viewportChanged) && this.link) {
                this.link = null;
                this.view.dom.classList.remove("cm-open-link-active");
                this.view.dom.removeAttribute("title");
            }
        }
        destroy() {
            for (const type of ["pointermove", "pointerover"]) this.view.contentDOM.removeEventListener(type, this.move);
            this.view.contentDOM.removeEventListener("pointerleave", this.leave);
            this.window.removeEventListener("keydown", this.key);
            this.window.removeEventListener("keyup", this.key);
            this.window.removeEventListener("blur", this.blur);
            this.view.dom.classList.remove("cm-open-link-active");
            this.view.dom.removeAttribute("title");
        }
    }, {
        eventHandlers: {
            mousedown(event) {
                if (!this.view.contentDOM.contains(event.target)) return false;
                this.pointer = { x: event.clientX, y: event.clientY };
                return event.button === 0 && Boolean(this.atPointer(event));
            },
            click(event) {
                if (!this.view.contentDOM.contains(event.target)) return false;
                this.pointer = { x: event.clientX, y: event.clientY };
                const link = event.button === 0 && this.atPointer(event);
                if (!link) return false;
                event.preventDefault();
                this.window.open(link.href, "_blank", "noopener,noreferrer");
                return true;
            },
        },
    });
    const underline = layer({
        above: true,
        class: "cm-open-link-layer",
        update: (update) => update.docChanged || update.viewportChanged || update.geometryChanged
            || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(linkChanged))),
        markers: (view) => {
            const link = view.plugin(plugin)?.link;
            return link ? RectangleMarker.forRange(view, "cm-open-link", EditorSelection.range(link.from, link.to)) : [];
        },
    });
    return [
        Prec.highest(plugin),
        underline,
        EditorView.baseTheme({
            ".cm-open-link-layer": { pointerEvents: "none" },
            ".cm-open-link-layer .cm-open-link": { borderBottom: "1px solid currentColor", boxSizing: "border-box" },
            "&.cm-open-link-active .cm-content, &.cm-open-link-active .cm-content *": { cursor: "pointer !important" },
        }),
    ];
}
