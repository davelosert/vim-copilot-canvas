import { themeOptions } from "../shared/themes.js";

export function createSettings({ elements: e, api, onSettings }) {
    const handlers = new AbortController();
    let disposed = false;
    let settings;
    const listen = (element, type, fn) => element.addEventListener(type, fn, { signal: handlers.signal });
    e.theme.replaceChildren(...themeOptions.map(({ value, label }) => {
        const option = e.theme.ownerDocument.createElement("option");
        option.value = value; option.textContent = label; return option;
    }));
    function apply(value) {
        if (disposed) return;
        settings = { ...value };
        e.relative.checked = value.relativeLineNumbers;
        e.agentVim.checked = value.agentVimMode ?? true;
        e.theme.value = value.theme;
        onSettings(value);
    }
    const error = (reason) => { e.status.textContent = `Could not update settings: ${reason.message}`; };
    async function save(patch) {
        e.relative.disabled = e.theme.disabled = e.agentVim.disabled = true;
        e.status.textContent = "Saving settings...";
        try {
            const value = await api("settings", patch);
            if (disposed) return;
            apply(value);
            e.status.textContent = "Settings saved.";
        } catch (reason) {
            if (disposed) return;
            apply(settings);
            error(reason);
        } finally {
            if (!disposed) e.relative.disabled = e.theme.disabled = e.agentVim.disabled = false;
        }
    }
    listen(e.button, "click", async () => {
        e.dialog.showModal();
        e.relative.disabled = e.theme.disabled = e.agentVim.disabled = true;
        e.status.textContent = "Loading settings...";
        try {
            const value = await api("settings");
            if (disposed) return;
            apply(value);
            e.status.textContent = "";
        } catch (reason) { if (!disposed) error(reason); }
        finally { if (!disposed) e.relative.disabled = e.theme.disabled = e.agentVim.disabled = false; }
    });
    listen(e.relative, "change", () => save({ relativeLineNumbers: e.relative.checked }));
    listen(e.agentVim, "change", () => save({ agentVimMode: e.agentVim.checked }));
    listen(e.theme, "change", () => save({ theme: e.theme.value }));
    listen(e.close, "click", () => e.dialog.close());
    return { apply, dispose() { disposed = true; handlers.abort(); e.dialog.close(); } };
}
