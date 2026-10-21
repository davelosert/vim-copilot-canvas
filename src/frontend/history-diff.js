import { EditorState, Compartment } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import { normalizeText } from "../shared/change-map.js";
import { matchingRequestPrompts } from "../shared/request-matches.js";
import { SentPrompt } from "./history-request.js";

export function createHistoryDiff({ parent, before, after, path, agent, requests, canRevert, onRevert, onError, theme = [] }) {
    const doc = parent.ownerDocument;
    const controls = doc.createElement("div");
    controls.className = "history-diff-controls";
    const message = doc.createElement("p");
    message.className = "history-muted";
    message.setAttribute("role", "status");
    const host = doc.createElement("div");
    host.className = "history-inline-diff";
    parent.append(controls, message, host);
    let disposed = false, busy = false, current = after, errorMessage = "";
    const merge = new Compartment(), appearance = new Compartment(), prompts = new Compartment();
    const promptPanels = () => EditorView.decorations.of(Decoration.set(
        matchingRequestPrompts({ before, after: current, path, agent, requests }).map((match) =>
            Decoration.widget({ widget: new SentPrompt(match.prompt, match.label, "Matching request"), block: true, side: match.side }).range(match.position)), true));
    const button = (label, run) => {
        const element = doc.createElement("button");
        element.type = "button";
        element.textContent = label;
        element.addEventListener("click", run);
        return element;
    };
    const config = () => unifiedMergeView({
        original: normalizeText(before), allowInlineDiffs: true,
        collapseUnchanged: { margin: 3, minSize: 8 }, diffConfig: { scanLimit: 1000, timeout: 50 },
        mergeControls: (type, action) => {
            const element = button("Revert this change", (event) => { if (!busy) action(event); });
            element.hidden = type === "accept";
            element.disabled = !canRevert(current) || busy;
            return element;
        },
    });
    const revert = async (next) => {
        if (busy || disposed) return;
        busy = true;
        errorMessage = "";
        update();
        try {
            if (!canRevert(current)) throw new Error("The file has changed since this revision. Reopen its history before reverting.");
            const applied = await onRevert(current, next);
            if (disposed || !applied) return;
            current = next;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: normalizeText(next) },
                effects: prompts.reconfigure(promptPanels()) });
        } catch (error) {
            if (!disposed) { errorMessage = error.message; onError(error); }
        } finally {
            busy = false;
            if (!disposed) {
                update();
                view.dispatch({ effects: merge.reconfigure(config()) });
            }
        }
    };
    const separator = after.includes("\r\n") ? "\r\n" : "\n";
    const view = new EditorView({
        parent: host,
        state: EditorState.create({
            doc: normalizeText(after),
            extensions: [
                EditorState.readOnly.of(true), EditorState.lineSeparator.of("\n"),
                EditorView.lineWrapping, lineNumbers(), appearance.of(theme), merge.of(config()), prompts.of(promptPanels()),
                EditorView.contentAttributes.of({ "aria-label": "Inline history diff" }),
            ],
        }),
        dispatchTransactions(transactions, target) {
            if (transactions.some((transaction) => transaction.docChanged)) {
                const next = transactions.at(-1).newDoc.toString().replace(/\n/g, separator);
                if (busy) target.update(transactions);
                else void revert(next);
            } else target.update(transactions);
        },
    });
    const all = button("Revert all changes in this entry", () => { void revert(normalizeText(before).replace(/\n/g, separator)); });
    controls.append(all);
    function update() {
        all.disabled = busy || !canRevert(current) || normalizeText(before) === normalizeText(current);
        if (busy) message.textContent = "Saving reverted changes...";
        else message.textContent = errorMessage || (canRevert(current)
            ? "Reverts update the file and can be undone in the editor."
            : "Historical snapshot: reverting is disabled because the current file differs.");
    }
    update();
    return {
        reviewingRevert() { return busy || current !== after; },
        refresh() { if (!disposed && !busy) { update(); view.dispatch({ effects: merge.reconfigure(config()) }); } },
        theme(value) { if (!disposed) view.dispatch({ effects: appearance.reconfigure(value) }); },
        dispose() { disposed = true; view.destroy(); },
    };
}
