export function createReview({ elements: e, api, edit, onMarkers, onError, confirm }) {
    const navigator = e.send.ownerDocument.defaultView.navigator;
    const mac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
    e.send.querySelector("kbd").textContent = mac ? "⌘⇧⏎" : "Ctrl+Shift+Enter";
    let items = [], key = "", submitting = false, disposed = false;
    const handlers = new AbortController();
    let rows = new AbortController();
    const listen = (element, type, fn) => element.addEventListener(type, fn, { signal: handlers.signal });
    const safe = (promise) => Promise.resolve(promise).catch((error) => { if (!disposed) onError(error); });
    function markers(path) {
        if (disposed) return;
        onMarkers(items.filter((item) => item.path === path));
    }
    function set(result) {
        if (disposed) return;
        items = result.items;
        const next = JSON.stringify(items);
        if (key === next) return;
        key = next;
        rows.abort();
        rows = new AbortController();
        e.bar.hidden = !items.length;
        e.count.textContent = `${items.length} pending request${items.length === 1 ? "" : "s"}`;
        e.list.replaceChildren(...items.map((item) => {
            const doc = e.list.ownerDocument;
            const row = doc.createElement("li");
            const open = doc.createElement("button");
            open.type = "button"; open.className = "review-item";
            const label = doc.createElement("strong"); label.textContent = item.label;
            const prompt = doc.createElement("span"); prompt.textContent = item.prompt;
            open.append(label, prompt);
            open.title = `${item.path}\n\n${item.prompt}`;
            open.addEventListener("click", () => safe(edit(item)), { signal: rows.signal });
            const change = doc.createElement("button");
            change.type = "button"; change.className = "review-edit"; change.textContent = "Edit";
            change.setAttribute("aria-label", `Edit comment on ${item.label}`);
            change.addEventListener("click", () => safe(edit(item)), { signal: rows.signal });
            const remove = doc.createElement("button");
            remove.type = "button"; remove.className = "review-remove"; remove.textContent = "×";
            remove.setAttribute("aria-label", `Remove comment on ${item.label}`);
            remove.addEventListener("click", () => safe(api("review/remove", { ids: [item.id] }).then(set)), { signal: rows.signal });
            row.append(open, change, remove);
            return row;
        }));
        if (!items.length) e.list.hidden = true;
        e.toggle.setAttribute("aria-expanded", String(!e.list.hidden));
        onMarkers(null);
    }
    async function submit() {
        if (disposed || submitting || !items.length) return;
        submitting = true; e.send.disabled = true;
        const count = items.length;
        e.status.textContent = "Sending batch...";
        try {
            const result = await api("review/send", {});
            if (disposed) return;
            set(result);
            e.status.textContent = `Sent batch (${count}) to Agent`;
        } catch (error) {
            if (!disposed) e.status.textContent = "";
            throw error;
        } finally {
            submitting = false;
            if (!disposed) e.send.disabled = false;
        }
    }
    async function discard() {
        if (disposed || !items.length || !confirm(`Discard batch of ${items.length} pending request${items.length === 1 ? "" : "s"}?`)) return;
        set(await api("review/clear", {}));
        if (!disposed) e.status.textContent = "Batch discarded";
    }
    listen(e.send, "click", () => safe(submit()));
    listen(e.discard, "click", () => safe(discard()));
    listen(e.toggle, "click", () => {
        e.list.hidden = !e.list.hidden;
        e.toggle.setAttribute("aria-expanded", String(!e.list.hidden));
    });
    return {
        set, markers, submit, discard,
        count: () => items.length,
        refresh: async () => { if (!disposed) set(await api("review")); },
        dispose() { disposed = true; handlers.abort(); rows.abort(); e.list.replaceChildren(); },
    };
}
