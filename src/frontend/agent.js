import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, placeholder } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { captureContext } from "./selection-context.js";
export { captureContext } from "./selection-context.js";

const setPrompt = StateEffect.define();
const setMarkers = StateEffect.define();
const pendingLine = Decoration.line({ class: "cm-agent-pending" });

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

function button(text, title, onClick) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = text;
    element.title = title;
    element.addEventListener("click", onClick);
    return element;
}

export function createAgent({ getPath, reviewCount, send, addToReview, sendReview, onDone, extensions = () => [] }) {
    let disposed = false;
    const prompts = new Set();
    class Prompt extends WidgetType {
        constructor(context) {
            super();
            this.context = context;
        }
        toDOM(view) {
            const reviewing = reviewCount() > 0;
            const form = document.createElement("div");
            form.className = "agent-prompt";
            form.setAttribute("role", "group");
            form.setAttribute("aria-label", "Send to Agent");
            const header = document.createElement("div");
            header.className = "agent-header";
            const title = document.createElement("span");
            title.textContent = `Agent · ${this.context.label}`;
            const mode = document.createElement("span");
            mode.className = "mode";
            header.append(title, mode);
            const host = document.createElement("div");
            host.className = "agent-input";
            const readOnly = new Compartment();
            const inner = new EditorView({
                parent: host,
                state: EditorState.create({
                    extensions: [
                        vim(), minimalSetup, EditorView.lineWrapping, readOnly.of(EditorState.readOnly.of(false)),
                        placeholder(reviewing ? "Add a review comment for the agent..." : "Describe a change or ask a question..."),
                        EditorView.contentAttributes.of({ "aria-label": "Agent prompt", spellcheck: "true" }),
                        ...extensions(),
                    ],
                }),
            });
            prompts.add(inner);
            let destroyed = false;
            const cm = getCM(inner);
            let currentMode = "normal";
            const showMode = (next, subMode) => {
                currentMode = next;
                mode.textContent = (next === "visual" && subMode ? `VISUAL ${subMode}` : next).toUpperCase();
                mode.dataset.mode = next.toUpperCase();
            };
            cm.on("vim-mode-change", ({ mode: next, subMode }) => showMode(next, subMode));
            showMode("normal");
            Vim.handleKey(cm, "i", "user");

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
                if (sending || (kind !== "send-review" && !prompt)) return;
                sending = true;
                inner.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(true)) });
                for (const control of actions.querySelectorAll("button")) control.disabled = true;
                status.textContent = kind === "review" ? "Adding to review..." : "Sending to Agent...";
                const input = { path: this.context.path, selections: this.context.selections, prompt };
                try {
                    if (kind === "send") await send(input);
                    else if (kind === "review") await addToReview(input);
                    else await sendReview(prompt ? input : null);
                    if (active()) {
                        close();
                        onDone(kind);
                    }
                } catch (error) {
                    if (active()) status.textContent = `Could not ${kind === "review" ? "add to review" : "send"}: ${error.message}`;
                } finally {
                    sending = false;
                    if (!destroyed && !disposed) {
                        inner.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(false)) });
                        for (const control of actions.querySelectorAll("button")) control.disabled = false;
                    }
                }
            };
            const hint = document.createElement("span");
            hint.textContent = reviewing
                ? "↵ add to review · ⌃⇧↵ send review · ⇧↵ newline · Esc Esc cancel"
                : "↵ send · ⌃↵ start review · ⇧↵ newline · Esc Esc cancel";
            if (reviewing) {
                actions.append(hint,
                    button("Add to review", "Enter or Ctrl+Enter", () => submit("review")),
                    button(`Send review (${reviewCount()})`, "Ctrl+Shift+Enter: send all review comments, including this one", () => submit("send-review")));
            } else {
                actions.append(hint,
                    button("Send to Agent", "Enter", () => submit("send")),
                    button("Add to review", "Ctrl+Enter: collect comments and send them together", () => submit("review")));
            }
            actions.append(button("Cancel", "Esc in Normal mode", () => { if (!sending) close(); }));

            form.addEventListener("keydown", (event) => {
                if (event.target !== inner.contentDOM || event.isComposing) return;
                const mod = event.ctrlKey || event.metaKey;
                if (event.key === "Enter" && !event.altKey && (currentMode === "insert" || currentMode === "normal")) {
                    if (mod && event.shiftKey) submit("send-review");
                    else if (mod) submit("review");
                    else if (!event.shiftKey) submit(reviewing ? "review" : "send");
                    else return;
                    event.preventDefault();
                    event.stopPropagation();
                } else if (event.key === "Escape" && currentMode === "normal") {
                    const input = cm.state.vim?.inputState;
                    if (input?.operator || input?.keyBuffer?.some(Boolean)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (!sending) close();
                }
            }, true);
            // Keep panel keystrokes away from the surrounding editor's Vim handler.
            form.addEventListener("keydown", (event) => event.stopPropagation());
            form.append(header, host, actions, status);
            form.inner = inner;
            form.disposePrompt = () => { destroyed = true; prompts.delete(inner); inner.destroy(); };
            this.inner = inner;
            return form;
        }
        destroy(dom) { dom.disposePrompt?.(); }
        ignoreEvent() { return true; }
    }

    return {
        extensions: [promptField, markerField],
        isOpen: (view) => view.state.field(promptField).size > 0,
        open(view) {
            if (disposed) return;
            const existing = view.state.field(promptField);
            if (existing.size) {
                existing.between(0, view.state.doc.length, (_from, _to, decoration) => decoration.spec.widget.inner?.focus());
                return;
            }
            const widget = new Prompt(captureContext(view.state, getPath()));
            const at = view.state.doc.lineAt(view.state.selection.main.head).to;
            view.dispatch({ effects: setPrompt.of({ widget, position: at }) });
            widget.inner.focus();
            view.requestMeasure();
        },
        setMarkers(view, lines) {
            if (disposed) return;
            const { doc } = view.state;
            const unique = [...new Set(lines.filter((line) => line >= 1 && line <= doc.lines))].sort((a, b) => a - b);
            view.dispatch({ effects: setMarkers.of(Decoration.set(unique.map((line) => pendingLine.range(doc.line(line).from)))) });
        },
        dispose() {
            disposed = true;
            for (const inner of prompts) inner.destroy();
            prompts.clear();
        },
    };
}
