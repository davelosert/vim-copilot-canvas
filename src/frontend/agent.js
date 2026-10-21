import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, placeholder } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { captureContext } from "./selection-context.js";
export { captureContext } from "./selection-context.js";

const setPrompt = StateEffect.define();
const setMarkers = StateEffect.define();

const promptField = StateField.define({
    create: () => Decoration.none,
    update(value, transaction) {
        value = value.map(transaction.changes);
        for (const effect of transaction.effects) {
            if (effect.is(setPrompt)) {
                value = effect.value
                    ? Decoration.set([Decoration.widget({ widget: effect.value.widget, block: true, side: 1 }).range(effect.value.position)])
                    : Decoration.none;
            }
        }
        return value;
    },
    provide: (field) => EditorView.decorations.from(field),
});

// Review markers are mapped through local edits so they follow the commented text.
const markerField = StateField.define({
    create: () => Decoration.none,
    update(value, transaction) {
        value = value.map(transaction.changes);
        for (const effect of transaction.effects) {
            if (effect.is(setMarkers)) value = effect.value;
        }
        return value;
    },
    provide: (field) => EditorView.decorations.from(field),
});

const isMac = typeof navigator !== "undefined" &&
    /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
const keys = isMac
    ? { send: "⏎", mod: "⌘⏎", modShift: "⌘⇧⏎", newline: "⇧⏎", cancel: "Esc Esc" }
    : { send: "Enter", mod: "Ctrl+Enter", modShift: "Ctrl+Shift+Enter", newline: "Shift+Enter", cancel: "Esc Esc" };
const ariaKeys = { send: "Enter", mod: "Control+Enter Meta+Enter", modShift: "Control+Shift+Enter Meta+Shift+Enter" };

function kbd(text) {
    const element = document.createElement("kbd");
    element.textContent = text;
    return element;
}

function button(text, title, onClick, { shortcut, className } = {}) {
    const element = document.createElement("button");
    element.type = "button";
    element.title = title;
    element.className = `btn btn-sm${className ? ` ${className}` : ""}`;
    const label = document.createElement("span");
    label.textContent = text;
    element.append(label);
    if (shortcut) {
        const badge = kbd(keys[shortcut]);
        badge.setAttribute("aria-hidden", "true");
        element.append(badge);
        if (ariaKeys[shortcut]) element.setAttribute("aria-keyshortcuts", ariaKeys[shortcut]);
    }
    element.addEventListener("click", onClick);
    return element;
}

export function createAgent({ getPath, reviewCount, send, addToReview, editReview, removeReview, sendReview, onDone, extensions = () => [] }) {
    let disposed = false;
    let agentVimMode = true;
    const prompts = new Map();
    class Prompt extends WidgetType {
        constructor(context, item = null) {
            super();
            this.context = context;
            this.item = item;
        }
        toDOM(view) {
            const reviewing = reviewCount() > 0;
            const form = document.createElement("div");
            form.className = "agent-prompt primer-scope";
            form.dataset.colorMode = document.documentElement.dataset.canvasTheme ?? "light";
            form.dataset.lightTheme = "light";
            form.dataset.darkTheme = "dark";
            form.setAttribute("role", "group");
            form.setAttribute("aria-label", this.item ? "Edit batch comment" : "Send to Agent");
            const header = document.createElement("div");
            header.className = "agent-header";
            const title = document.createElement("span");
            title.className = "agent-title";
            title.append("Agent");
            const context = document.createElement("span");
            context.className = "agent-context";
            context.textContent = this.context.label;
            title.append(context);
            const mode = document.createElement("span");
            mode.className = "mode";
            header.append(title, mode);
            const host = document.createElement("div");
            host.className = "agent-input";
            const readOnly = new Compartment();
            const theme = new Compartment();
            const editingMode = new Compartment();
            const inner = new EditorView({
                parent: host,
                state: EditorState.create({
                    doc: this.item?.prompt ?? "",
                    extensions: [
                        editingMode.of(agentVimMode ? vim() : []), minimalSetup, EditorView.lineWrapping, readOnly.of(EditorState.readOnly.of(false)),
                        placeholder("Describe a change or ask a question..."),
                        EditorView.contentAttributes.of({ "aria-label": "Agent prompt", spellcheck: "true" }),
                        theme.of(extensions()),
                    ],
                }),
            });
            let destroyed = false;
            let cm;
            let currentMode = "normal";
            const showMode = (next, subMode) => {
                currentMode = next;
                mode.textContent = (next === "visual" && subMode ? `VISUAL ${subMode}` : next).toUpperCase();
                mode.dataset.mode = next.toUpperCase();
            };
            const modeListener = ({ mode: next, subMode }) => showMode(next, subMode);

            const status = document.createElement("div");
            status.className = "agent-status";
            status.setAttribute("role", "status");
            status.setAttribute("aria-live", "polite");
            let sending = false;
            const active = () => {
                if (disposed || destroyed) return false;
                let found = false;
                view.state.field(promptField).between(0, view.state.doc.length, (_from, _to, decoration) => {
                    if (decoration.spec.widget === this) found = true;
                });
                return found;
            };
            const close = () => {
                if (!active()) return;
                view.dispatch({ effects: setPrompt.of(null) });
                view.focus();
            };
            const actions = document.createElement("div");
            actions.className = "agent-actions";
            const submit = async (kind) => {
                const prompt = inner.state.doc.toString().trim();
                if (sending || (!["send-review", "delete"].includes(kind) && !prompt)) return;
                sending = true;
                this.sending = true;
                inner.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(true)) });
                for (const control of actions.querySelectorAll("button")) control.disabled = true;
                status.textContent = kind === "edit" ? "Saving comment..." : kind === "delete" ? "Deleting comment..." : kind === "review" ? "Adding to batch..." : "Sending to Agent...";
                const input = { path: this.context.path, selections: this.context.selections, prompt, context: this.context.content };
                try {
                    if (kind === "edit") await editReview({ id: this.item.id, prompt });
                    else if (kind === "delete") await removeReview(this.item.id);
                    else if (kind === "send") await send(input);
                    else if (kind === "review") await addToReview(input);
                    else await sendReview(prompt ? input : null);
                    if (active()) {
                        close();
                        onDone(kind);
                    }
                } catch (error) {
                    if (active()) status.textContent = `Could not ${kind === "edit" ? "save comment" : kind === "delete" ? "delete comment" : kind === "review" ? "add to batch" : "send"}: ${error.message}`;
                } finally {
                    sending = false;
                    this.sending = false;
                    if (!destroyed && !disposed) {
                        inner.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(false)) });
                        for (const control of actions.querySelectorAll("button")) control.disabled = false;
                    }
                }
            };
            const hint = document.createElement("div");
            hint.className = "agent-hint";
            hint.append(kbd(keys.newline), " new line");
            if (this.item) {
                actions.append(
                    button("Save changes", `${keys.send} or ${keys.mod}`, () => submit("edit"), { shortcut: "send", className: "btn-primary" }),
                    button("Delete comment", "Remove this comment from the batch", () => submit("delete")));
            } else {
                actions.append(
                    button("Send to Agent", keys.send, () => submit("send"), { shortcut: "send", className: "btn-primary" }),
                    button("Add to batch", `${keys.mod}: collect requests and send them together`, () => submit("review"), { shortcut: "mod" }));
                if (reviewing) actions.append(
                    button(`Send batch (${reviewCount()})`, `${keys.modShift}: send all pending requests, including this one`, () => submit("send-review"), { shortcut: "modShift" }));
            }
            const cancel = button("Cancel", `${keys.cancel} in Normal mode`, () => { if (!sending) close(); }, { className: "agent-cancel" });
            const cancelKey = kbd(keys.cancel);
            cancelKey.setAttribute("aria-hidden", "true");
            cancel.append(cancelKey);
            actions.append(cancel);
            const configureMode = () => {
                cm?.off("vim-mode-change", modeListener);
                inner.dispatch({ effects: editingMode.reconfigure(agentVimMode ? vim() : []) });
                mode.hidden = !agentVimMode;
                cancelKey.textContent = agentVimMode ? keys.cancel : "Esc";
                cancel.title = agentVimMode ? `${keys.cancel} in Normal mode` : "Esc";
                if (agentVimMode) {
                    cm = getCM(inner);
                    cm.on("vim-mode-change", modeListener);
                    showMode("normal");
                    Vim.handleKey(cm, "i", "user");
                } else {
                    cm = undefined;
                    currentMode = "insert";
                }
            };
            configureMode();
            prompts.set(inner, { theme, configureMode });

            form.addEventListener("keydown", (event) => {
                if (event.target !== inner.contentDOM || event.isComposing) return;
                const mod = event.ctrlKey || event.metaKey;
                if (event.key === "Enter" && !event.altKey && (currentMode === "insert" || currentMode === "normal")) {
                    if (this.item && (!event.shiftKey || mod)) submit("edit");
                    else if (this.item) return;
                    else if (mod && event.shiftKey) submit("send-review");
                    else if (mod) submit("review");
                    else if (!event.shiftKey) submit("send");
                    else return;
                    event.preventDefault();
                    event.stopPropagation();
                } else if (event.key === "Escape" && (!agentVimMode || currentMode === "normal")) {
                    const input = cm?.state.vim?.inputState;
                    if (input?.operator || input?.keyBuffer?.some(Boolean)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (!sending) close();
                }
            }, true);
            // Keep panel keystrokes away from the surrounding editor's Vim handler.
            form.addEventListener("keydown", (event) => event.stopPropagation());
            form.append(header, host, actions, hint, status);
            form.inner = inner;
            form.disposePrompt = () => { destroyed = true; cm?.off("vim-mode-change", modeListener); prompts.delete(inner); inner.destroy(); };
            this.inner = inner;
            return form;
        }
        destroy(dom) { dom.disposePrompt?.(); }
        ignoreEvent() { return true; }
    }

    function focusPrompt(view) {
        const existing = view.state.field(promptField);
        if (!existing.size) return false;
        existing.between(0, view.state.doc.length, (_from, _to, decoration) => decoration.spec.widget.inner?.focus());
        return true;
    }
    function showPrompt(view, widget, position) {
        view.dispatch({ effects: [setPrompt.of({ widget, position }), EditorView.scrollIntoView(position)] });
        widget.inner.focus();
        view.requestMeasure();
    }
    function edit(view, item, position) {
        if (disposed) return;
        let current;
        view.state.field(promptField).between(0, view.state.doc.length, (_from, _to, decoration) => {
            current = decoration.spec.widget;
        });
        if (current && (current.sending || current.item?.id === item.id || !current.item)) {
            focusPrompt(view);
            return;
        }
        if (position === undefined) {
            view.state.field(markerField).between(0, view.state.doc.length, (from, _to, decoration) => {
                if (position === undefined && decoration.spec.anchor && decoration.spec.item.id === item.id) position = from;
            });
        }
        const line = position === undefined
            ? view.state.doc.line(Math.min(item.lines[0].end, view.state.doc.lines))
            : view.state.doc.lineAt(position);
        view.dispatch({ selection: { anchor: line.from } });
        showPrompt(view, new Prompt({ path: item.path, label: item.label }, item), line.to);
    }
    function toggleComment(view, item, position) {
        if (disposed) return;
        let current;
        view.state.field(promptField).between(0, view.state.doc.length, (_from, _to, decoration) => {
            current = decoration.spec.widget;
        });
        if (current?.item?.id === item.id) {
            if (!current.sending) {
                view.dispatch({ effects: setPrompt.of(null) });
                view.focus();
            }
            return;
        }
        edit(view, item, position);
    }
    class CommentMarker extends GutterMarker {
        constructor(items, position) { super(); this.items = items; this.position = position; }
        eq(other) { return this.position === other.position && JSON.stringify(this.items) === JSON.stringify(other.items); }
        toDOM(view) {
            const host = document.createElement("span");
            host.className = "review-markers";
            for (const item of this.items) {
                const icon = button("", `${item.label}\n${item.prompt}`, () => {
                    toggleComment(view, item, this.position);
                }, { className: "review-marker" });
                icon.classList.remove("btn", "btn-sm");
                // CodeMirror hides gutters from assistive technology; the review list exposes Edit.
                icon.tabIndex = -1;
                icon.setAttribute("aria-label", `Edit comment on ${item.label}: ${item.prompt}`);
                icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 2.5h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-4 3v-3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z"/></svg>';
                host.append(icon);
            }
            return host;
        }
    }

    return {
        applySettings(value) {
            const next = value.agentVimMode ?? true;
            if (disposed || next === agentVimMode) return;
            agentVimMode = next;
            for (const { configureMode } of prompts.values()) configureMode();
        },
        updateTheme() {
            if (disposed) return;
            for (const [inner, { theme }] of prompts) {
                inner.dispatch({ effects: theme.reconfigure(extensions()) });
            }
        },
        edit,
        extensions: [promptField, markerField, gutter({
            class: "cm-review-gutter", side: "before",
            lineMarker(view, line) {
                const items = [];
                view.state.field(markerField).between(line.from, line.from, (from, _to, decoration) => {
                    if (from === line.from && decoration.spec.anchor) items.push(decoration.spec.item);
                });
                return items.length ? new CommentMarker(items, line.from) : null;
            },
            lineMarkerChange: (update) => update.docChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setMarkers))),
        })],
        isOpen: (view) => view.state.field(promptField).size > 0,
        open(view) {
            if (disposed) return;
            if (focusPrompt(view)) return;
            const widget = new Prompt({ ...captureContext(view.state, getPath()), content: view.state.sliceDoc() });
            const at = view.state.doc.lineAt(view.state.selection.main.head).to;
            showPrompt(view, widget, at);
        },
        setMarkers(view, items) {
            if (disposed) return;
            const { doc } = view.state;
            const positions = new Map();
            view.state.field(markerField).between(0, doc.length, (from, _to, decoration) => {
                positions.set(decoration.spec.markerKey, doc.lineAt(from).from);
            });
            const markers = items.flatMap((item) => item.lines.flatMap(({ start, end }, range) =>
                Array.from({ length: end - start + 1 }, (_, offset) => {
                    const markerKey = `${item.id}:${range}:${offset}`;
                    const position = positions.get(markerKey) ?? (start + offset <= doc.lines && start + offset >= 1 ? doc.line(start + offset).from : null);
                    return position === null ? [] : [Decoration.line({
                        class: "cm-agent-pending", markerKey, item, anchor: start + offset === end,
                    }).range(position)];
                }).flat()));
            view.dispatch({ effects: setMarkers.of(Decoration.set(markers, true)) });
        },
        dispose() {
            disposed = true;
            for (const inner of prompts.keys()) inner.destroy();
            prompts.clear();
        },
    };
}
