import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers, WidgetType } from "@codemirror/view";
import { normalizeText } from "../shared/change-map.js";
import { selectionRange } from "../shared/selection-range.js";

export class SentPrompt extends WidgetType {
    constructor(prompt, label, title = "Sent request") { super(); this.prompt = prompt; this.label = label; this.title = title; }
    toDOM(view) {
        const doc = view.dom.ownerDocument;
        const element = doc.createElement("section");
        element.className = "history-sent-prompt";
        element.setAttribute("aria-label", `Sent request on ${this.label}`);
        const heading = doc.createElement("div");
        heading.className = "history-sent-prompt-heading";
        const title = doc.createElement("strong");
        title.textContent = this.title;
        const location = doc.createElement("span");
        location.textContent = this.label;
        const text = doc.createElement("pre");
        text.textContent = this.prompt;
        heading.append(title, location);
        element.append(heading, text);
        return element;
    }
    ignoreEvent() { return true; }
}

export function createHistoryRequest({ parent, entry, theme = [] }) {
    const doc = parent.ownerDocument, groups = [];
    for (const item of entry.items) {
        const snapshot = entry.snapshots?.[item.snapshot];
        if (snapshot && entry.type !== "batch") {
            let group = groups.find((group) => group.snapshot === item.snapshot);
            if (!group) {
                group = { snapshot: item.snapshot, path: item.path, content: normalizeText(snapshot.content), prompts: [] };
                groups.push(group);
            }
            for (const attachment of item.attachments) {
                const range = selectionRange(group.content, attachment);
                if (!range) throw new Error("Saved request selections do not match their document snapshot.");
                group.prompts.push({ ...range, prompt: item.prompt, label: attachment.displayName ?? item.label ?? item.path });
            }
        } else {
            for (const attachment of item.attachments) {
                const content = normalizeText(attachment.text);
                groups.push({
                    path: item.path, content, excerpt: attachment.selection.start, saved: !!snapshot,
                    prompts: [{ from: 0, to: content.length, prompt: item.prompt,
                        label: attachment.displayName ?? item.label ?? item.path }],
                });
            }
        }
    }
    const stack = doc.createElement("div");
    stack.className = "history-request-stack";
    parent.append(stack);
    const views = [];
    if (!groups.length) stack.textContent = "No saved selections are available for this request.";
    for (const [index, group] of groups.entries()) {
        const section = doc.createElement("section");
        section.className = "history-request-item";
        const heading = doc.createElement("h4");
        heading.textContent = `${index + 1}. ${group.path}`;
        const status = doc.createElement("p");
        status.className = "history-muted";
        status.setAttribute("role", "status");
        const host = doc.createElement("div");
        host.className = "history-request-source";
        section.append(heading, status, host);
        stack.append(section);
        const appearance = new Compartment();
        const text = EditorState.create({ doc: group.content }).doc;
        const decorations = [];
        for (const [index, prompt] of group.prompts.entries()) {
            if (prompt.to > prompt.from) decorations.push(Decoration.mark({ class: "history-request-selection" }).range(prompt.from, prompt.to));
            const end = text.lineAt(prompt.to > prompt.from ? prompt.to - 1 : prompt.from).to;
            decorations.push(Decoration.widget({
                widget: new SentPrompt(prompt.prompt, prompt.label), block: true, side: index + 1,
            }).range(end));
        }
        status.textContent = group.excerpt
            ? `${group.saved ? "Original selection" : "Only the original selection was retained"} (line ${group.excerpt.line + 1}, column ${group.excerpt.character + 1}).${group.saved ? " Read-only." : " The full historical file is unavailable."}`
            : "Original document and prompts captured when the request was created. Read-only; not the current file.";
        const view = new EditorView({
            parent: host,
            state: EditorState.create({
                doc: group.content,
                extensions: [
                    EditorState.readOnly.of(true), EditorView.lineWrapping,
                    lineNumbers({ formatNumber: (line) => String(line + (group.excerpt?.line ?? 0)) }),
                    appearance.of(theme), EditorView.decorations.of(Decoration.set(decorations, true)),
                    EditorView.contentAttributes.of({ "aria-label": "Historical request source", spellcheck: "false" }),
                ],
            }),
        });
        views.push({ view, appearance });
    }
    const outgoing = doc.createElement("details"), summary = doc.createElement("summary"), message = doc.createElement("pre");
    outgoing.className = "history-outgoing-message";
    summary.textContent = "Exact outgoing message";
    message.textContent = entry.prompt;
    outgoing.append(summary, message);
    parent.append(outgoing);
    return {
        theme(value) { for (const { view, appearance } of views) view.dispatch({ effects: appearance.reconfigure(value) }); },
        dispose() { for (const { view } of views) view.destroy(); },
    };
}
