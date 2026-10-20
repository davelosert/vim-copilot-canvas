import { themeOptions } from "../shared/themes.js";

export function createSettings({ elements: e, api, onSettings }) {
    const handlers = new AbortController();
    let disposed = false, saving = false, generation = 0;
    let settings, persisted;
    const keys = ["relativeLineNumbers", "showKeyboardShortcutIndicators", "agentVimMode", "theme"];
    const listen = (element, type, fn) => element.addEventListener(type, fn, { signal: handlers.signal });
    const controls = [e.relative, e.shortcuts, e.agentVim, e.theme];
    for (const control of controls) control.disabled = true;
    const difference = (base, value) => Object.fromEntries(keys.filter((key) => base[key] !== value[key]).map((key) => [key, value[key]]));
    function updateActions() {
        const dirty = settings && Object.keys(difference(persisted, settings)).length > 0;
        e.save.disabled = saving || !dirty;
        e.discard.disabled = saving || !dirty;
        e.close.disabled = saving;
    }
    updateActions();
    e.theme.replaceChildren(...themeOptions.map(({ value, label }) => {
        const option = e.theme.ownerDocument.createElement("option");
        option.value = value; option.textContent = label; return option;
    }));
    function render(value) {
        if (disposed) return;
        const previous = settings;
        settings = { ...value };
        e.relative.checked = value.relativeLineNumbers;
        e.shortcuts.checked = value.showKeyboardShortcutIndicators ?? true;
        e.agentVim.checked = value.agentVimMode ?? true;
        e.theme.value = value.theme;
        for (const control of controls) control.disabled = false;
        updateActions();
        if (!previous || keys.some((key) => value[key] !== previous[key])) onSettings(settings, previous);
    }
    function apply(value) {
        if (disposed) return;
        persisted = { ...value };
        render(value);
    }
    const error = (reason) => { e.status.textContent = `Could not update settings: ${reason.message}`; };
    async function save() {
        if (saving || !settings) return;
        const patch = difference(persisted, settings);
        if (!Object.keys(patch).length) return;
        const submitted = { ...settings };
        generation++;
        saving = true;
        updateActions();
        e.status.textContent = "Saving settings...";
        try {
            const value = await api("settings", patch);
            if (disposed) return;
            // Saving commits the submitted snapshot, not previews made while it was in flight.
            const newer = difference(submitted, settings);
            persisted = { ...value };
            render({ ...value, ...newer });
            e.status.textContent = Object.keys(newer).length ? "Unsaved changes." : "Settings saved.";
        } catch (reason) {
            if (!disposed) error(reason);
        } finally {
            saving = false;
            if (!disposed) updateActions();
        }
    }
    function preview(patch) {
        generation++;
        render({ ...settings, ...patch });
        if (!saving) e.status.textContent = Object.keys(difference(persisted, settings)).length ? "Unsaved changes." : "";
    }
    function discard() {
        if (saving) return;
        generation++;
        if (persisted) render(persisted);
        e.status.textContent = "";
    }
    function close() {
        if (saving) return;
        discard();
        e.dialog.close();
    }
    listen(e.button, "click", async () => {
        e.dialog.showModal();
        if (saving) return;
        const request = ++generation;
        e.status.textContent = "Loading settings...";
        try {
            const value = await api("settings");
            if (disposed || request !== generation) return;
            apply(value);
            e.status.textContent = "";
        } catch (reason) { if (!disposed && request === generation) error(reason); }
    });
    listen(e.relative, "change", () => preview({ relativeLineNumbers: e.relative.checked }));
    listen(e.shortcuts, "change", () => preview({ showKeyboardShortcutIndicators: e.shortcuts.checked }));
    listen(e.agentVim, "change", () => preview({ agentVimMode: e.agentVim.checked }));
    listen(e.theme, "change", () => preview({ theme: e.theme.value }));
    listen(e.save, "click", save);
    listen(e.discard, "click", discard);
    listen(e.close, "click", close);
    listen(e.dialog, "cancel", (event) => { event.preventDefault(); close(); });
    listen(e.dialog, "close", () => { if (!e.dialog.open) discard(); });
    return { apply, dispose() { disposed = true; handlers.abort(); e.dialog.close(); } };
}
