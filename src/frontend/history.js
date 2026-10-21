import { changedChunks, findHistoricalText } from "../shared/change-map.js";
import { createHistoryDiff } from "./history-diff.js";
import { copilotIcon } from "./copilot-icon.js";
import { createHistoryRequest } from "./history-request.js";

export function createHistory({ list, detail, status, api, readText, onJump, onOpen, onLeave, onError,
    review, onReview, onCloseReview, canRevert = () => false, onRevert, theme = () => [] }) {
    const doc = list.ownerDocument;
    let path, generation = 0, detailRequest = 0, version, selected, active = false, disposed = false, loading = false;
    const handlers = new AbortController();
    let inlineReview, reviewClosed = false;
    const clearDiff = (close = true) => {
        inlineReview?.dispose(); inlineReview = undefined;
        review.diff.replaceChildren();
        if (close) {
            review.panel.hidden = true;
            review.panel.removeAttribute("aria-busy");
            onCloseReview();
        }
    };
    const revealReview = () => {
        if (!review.panel.hidden) return;
        review.panel.hidden = false;
        onReview();
    };
    const closeReview = () => { reviewClosed = true; detailRequest++; clearDiff(); };
    const node = (tag, text, className) => {
        const element = doc.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    const fail = (error) => {
        if (disposed) return;
        status.textContent = error.message;
        onError(error);
    };
    const destination = (parent, text, targetPath = path) => {
        const button = node("button", targetPath === path ? "Jump to current text" : "Open referenced file");
        button.type = "button";
        const resolve = () => findHistoricalText(text, readText());
        if (targetPath === path && resolve() === null) {
            button.disabled = true;
            button.textContent = "Historical location (text changed or ambiguous)";
        }
        button.addEventListener("click", async () => {
            try {
                if (targetPath !== path && !await onOpen(targetPath)) return;
                const line = resolve();
                if (line === null) {
                    status.textContent = "The original text is changed, deleted, or ambiguous; no exact jump is available.";
                    return;
                }
                onJump(line);
            } catch (error) { fail(error); }
        }, { signal: handlers.signal });
        parent.append(button);
    };
    const renderChange = (entry) => {
        const { a, b, chunks } = changedChunks(entry.before, entry.after);
        let added = 0, removed = 0;
        const entryPath = path;
        review.title.textContent = `${entry.agent ? "Copilot file write" : entry.source === "vim" ? "Vim edit" : "External edit"} · ${new Date(entry.time).toLocaleString()}`;
        revealReview();
        inlineReview = createHistoryDiff({
            parent: review.diff, before: entry.before, after: entry.after, theme: theme(),
            path: entryPath, agent: entry.agent, requests: entry.requests,
            canRevert: (expected) => canRevert(entryPath, expected),
            onRevert: (expected, next) => onRevert(entryPath, expected, next),
            onError: fail,
        });
        for (const chunk of chunks) {
            const startA = a.lineAt(chunk.fromA).number, startB = b.lineAt(chunk.fromB).number;
            const endA = chunk.fromA === chunk.toA ? startA - 1 : a.lineAt(Math.min(chunk.endA, a.length)).number;
            const endB = chunk.fromB === chunk.toB ? startB - 1 : b.lineAt(Math.min(chunk.endB, b.length)).number;
            removed += Math.max(0, endA - startA + 1);
            added += Math.max(0, endB - startB + 1);
            const section = node("section", undefined, "history-hunk");
            section.append(node("h4", `@@ -${startA},${Math.max(0, endA - startA + 1)} +${startB},${Math.max(0, endB - startB + 1)} @@`));
            if (!chunk.precise) section.append(node("p", "Coarse diff: this region was extensively rewritten."));
            const surviving = chunk.fromB === chunk.toB
                ? b.line(Math.min(startB, b.lines)).text
                : b.sliceString(chunk.fromB, Math.min(chunk.toB, b.length));
            destination(section, surviving);
            detail.append(section);
        }
        detail.prepend(node("p", `+${added} / -${removed} lines`, "history-counts"));
        detail.prepend(node("p", "Diff shown in the main editor. Return to editing to leave history review.", "history-muted"));
        if (entry.agent) {
            detail.append(node("p", `Copilot committed a file write${entry.agent.toolName ? ` via ${entry.agent.toolName}` : ""}. This snapshot may also include concurrent edits.`, "history-muted"));
        }
    };
    async function show(id) {
        selected = id;
        reviewClosed = false;
        const current = generation;
        const request = ++detailRequest;
        review.panel.setAttribute("aria-busy", "true");
        if (!inlineReview) detail.replaceChildren(node("p", "Loading entry..."));
        try {
            const entry = await api(`history/entry?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`);
            if (disposed || current !== generation || selected !== id || request !== detailRequest) return;
            clearDiff(false);
            detail.replaceChildren(node("h3", entry.type === "change" ? "File changes" :
                entry.type === "batch" ? `Batch sent to Copilot (${entry.items.length})` : "Request sent to Copilot"));
            if (entry.type !== "change") detail.firstChild.prepend(copilotIcon(doc));
            if (entry.type === "change") renderChange(entry);
            else {
                detail.append(node("p", "Sent request, not confirmation of completed edits.", "history-muted"));
                detail.append(node("p", "Original selections and prompts are shown in the editor.", "history-muted"));
                review.title.textContent = `${entry.type === "batch" ? "Batch request" : "Sent request"} · ${new Date(entry.time).toLocaleString()}`;
                revealReview();
                inlineReview = createHistoryRequest({ parent: review.diff, entry, path, theme: theme() });
            }
            for (const button of list.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.id === id));
        } catch (error) {
            if (current === generation && request === detailRequest && !disposed) { clearDiff(); detail.replaceChildren(); fail(error); }
        } finally {
            if (current === generation && request === detailRequest) review.panel.removeAttribute("aria-busy");
        }
    }
    async function refresh() {
        if (!active || !path || disposed || loading) return;
        loading = true;
        const current = generation;
        try {
            const result = await api(`history?path=${encodeURIComponent(path)}`);
            if (disposed || current !== generation) return;
            status.textContent = result.uncertain?.length
                ? "A delivery outcome is unknown. Check the conversation before resending."
                : result.pruned ? `${result.pruned} older entries pruned by retention limits.` : "";
            if (result.version === version) { inlineReview?.refresh?.(); return; }
            version = result.version;
            const focusedId = doc.activeElement?.dataset.id;
            list.replaceChildren();
            for (const entry of result.entries) {
                const row = node("li", undefined, `history-event history-${entry.type === "change" ? entry.agent ? "copilot" : entry.source : entry.type}`);
                const title = entry.type === "change" ? (entry.agent ? "Copilot file write" : entry.source === "vim" ? "Vim edit" : "External edit") :
                    entry.type === "batch" ? `Sent batch (${entry.count} requests)` : "Sent to Copilot";
                const button = node("button");
                button.type = "button";
                button.dataset.id = entry.id;
                button.setAttribute("aria-pressed", String(selected === entry.id));
                const label = node("strong", title);
                if (entry.type !== "change" || entry.agent) label.prepend(copilotIcon(doc));
                const kind = node("span", entry.type === "change" ? "EDIT" : "REQUEST", "history-event-kind");
                button.append(kind, label, node("time", new Date(entry.time).toLocaleString()));
                if (entry.counts) button.append(node("span", `+${entry.counts.added} / -${entry.counts.removed} lines`));
                row.append(button);
                list.append(row);
            }
            if (!result.entries.length) list.append(node("li", "No recorded history yet."));
            const selectedEntry = result.entries.find((entry) => entry.id === selected);
            if (selectedEntry) {
                if (reviewClosed) return;
                if (selectedEntry.type !== "change" || inlineReview?.reviewingRevert()) inlineReview?.refresh?.();
                else await show(selected);
            }
            else { selected = undefined; clearDiff(); detail.replaceChildren(node("p", "Select an event to review its details.")); }
            if (focusedId) [...list.querySelectorAll("button")].find((button) => button.dataset.id === focusedId)?.focus();
        } catch (error) { if (!disposed && current === generation) fail(error); }
        finally {
            loading = false;
            if (current !== generation && !disposed) void refresh();
        }
    }
    list.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-id]");
        if (button) void show(button.dataset.id);
    }, { signal: handlers.signal });
    review.close.addEventListener("click", () => { closeReview(); onLeave(); }, { signal: handlers.signal });
    review.panel.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); closeReview(); onLeave(); }
    }, { signal: handlers.signal });
    list.parentElement.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); onLeave(); return; }
        if (event.target.closest("#history-detail")) return;
        const buttons = [...list.querySelectorAll("button:not(:disabled)")];
        const index = buttons.indexOf(doc.activeElement);
        const next = { j: Math.min(index + 1, buttons.length - 1), k: Math.max(0, index - 1),
            ArrowDown: Math.min(index + 1, buttons.length - 1), ArrowUp: Math.max(0, index - 1),
            Home: 0, g: 0, End: buttons.length - 1, G: buttons.length - 1 }[event.key];
        if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
    }, { signal: handlers.signal });
    return {
        document(snapshot) {
            if (path === snapshot.path) return;
            clearDiff();
            path = snapshot.path; generation++; version = selected = undefined;
            list.replaceChildren(); detail.replaceChildren(); status.textContent = "";
            void refresh();
        },
        activate(value) { active = value; if (active) void refresh(); else closeReview(); },
        closeReview,
        refresh,
        theme() { inlineReview?.theme(theme()); },
        focus() { (list.querySelector("button") ?? list).focus(); },
        dispose() { disposed = true; generation++; clearDiff(); handlers.abort(); },
    };
}
