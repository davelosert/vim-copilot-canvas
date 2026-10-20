import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EditorError } from "./errors.mjs";
import { editorThemes } from "../shared/themes.js";

export function settingsPath(home = process.env.COPILOT_HOME || join(homedir(), ".copilot")) {
    return join(home, "extensions", "vim-markdown", "artifacts", "settings.json");
}

export class SettingsStore {
    constructor(path = settingsPath()) {
        this.path = path;
        this.pending = Promise.resolve();
    }

    async read() {
        let source;
        try { source = await readFile(this.path, "utf8"); }
        catch (error) {
            if (error.code === "ENOENT") return { relativeLineNumbers: false, showKeyboardShortcutIndicators: true, theme: "system", agentVimMode: true };
            throw error;
        }
        let value;
        try { value = JSON.parse(source); }
        catch { throw new EditorError("invalid_settings", "Canvas settings contain invalid JSON.", 500); }
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            (value.relativeLineNumbers !== undefined && typeof value.relativeLineNumbers !== "boolean") ||
            (value.showKeyboardShortcutIndicators !== undefined && typeof value.showKeyboardShortcutIndicators !== "boolean") ||
            (value.agentVimMode !== undefined && typeof value.agentVimMode !== "boolean") ||
            (value.theme !== undefined && !Object.hasOwn(editorThemes, value.theme))) {
            throw new EditorError("invalid_settings", "Canvas settings contain an invalid relativeLineNumbers, showKeyboardShortcutIndicators, agentVimMode, or theme setting.", 500);
        }
        return {
            ...value,
            relativeLineNumbers: value.relativeLineNumbers ?? false,
            showKeyboardShortcutIndicators: value.showKeyboardShortcutIndicators ?? true,
            theme: value.theme ?? "system",
            agentVimMode: value.agentVimMode ?? true,
        };
    }

    update(input) {
        const run = async () => {
            if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0 ||
                Object.keys(input).some((key) => !["relativeLineNumbers", "showKeyboardShortcutIndicators", "agentVimMode", "theme"].includes(key)) ||
                (input.relativeLineNumbers !== undefined && typeof input.relativeLineNumbers !== "boolean") ||
                (input.showKeyboardShortcutIndicators !== undefined && typeof input.showKeyboardShortcutIndicators !== "boolean") ||
                (input.agentVimMode !== undefined && typeof input.agentVimMode !== "boolean") ||
                (input.theme !== undefined && (typeof input.theme !== "string" || !Object.hasOwn(editorThemes, input.theme)))) {
                throw new EditorError("invalid_settings", "Expected relativeLineNumbers, showKeyboardShortcutIndicators, or agentVimMode booleans and/or a supported theme name.", 400);
            }
            const value = { ...(await this.read()), ...input };
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            const temporary = `${this.path}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
                await rename(temporary, this.path);
            } finally {
                await rm(temporary, { force: true });
            }
            return value;
        };
        const result = this.pending.then(run);
        this.pending = result.catch(() => {});
        return result;
    }
}
