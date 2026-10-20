import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { settingsPath } from "../../src/backend/settings-store.mjs";
import { DocumentStore, SettingsStore, Workspace, apiClient, startEditorServer, tempDir } from "../helpers/fixtures.mjs";

async function fixture() {
    const root = await tempDir("vim-settings-");
    const path = settingsPath(root);
    return { root, path, settings: new SettingsStore(path) };
}

test("settings use the standard global canvas artifacts directory", () => {
    assert.equal(settingsPath("/custom/copilot"), join("/custom/copilot", "extensions", "vim-markdown", "artifacts", "settings.json"));
    assert.equal(settingsPath(), join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions", "vim-markdown", "artifacts", "settings.json"));
});

test("settings default to absolute numbers, visible shortcut indicators, and the system theme, and persist across stores", async () => {
    const { path, settings } = await fixture();
    assert.deepEqual(await settings.read(), { relativeLineNumbers: false, showKeyboardShortcutIndicators: true, agentVimMode: true, theme: "system" });
    await settings.update({ relativeLineNumbers: true });
    await settings.update({ showKeyboardShortcutIndicators: false, agentVimMode: true });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { relativeLineNumbers: true, showKeyboardShortcutIndicators: false, agentVimMode: true, theme: "system" });
    await settings.update({ theme: "dracula" });
    const reopened = new SettingsStore(path);
    assert.deepEqual(await reopened.read(), { relativeLineNumbers: true, showKeyboardShortcutIndicators: false, agentVimMode: true, theme: "dracula" });
    await reopened.update({ relativeLineNumbers: false });
    assert.deepEqual(await settings.read(), { relativeLineNumbers: false, showKeyboardShortcutIndicators: false, agentVimMode: true, theme: "dracula" });
    assert.deepEqual(await readdir(dirname(path)), ["settings.json"]);
});

test("settings reject invalid updates without changing persisted preferences", async () => {
    const { settings } = await fixture();
    await settings.update({ relativeLineNumbers: true });
    for (const input of [null, [], {}, true, { relativeLineNumbers: "true" }, { showKeyboardShortcutIndicators: 1 }, { agentVimMode: "false" },
        { theme: "unknown" }, { relativeLineNumbers: false, other: true }]) {
        await assert.rejects(settings.update(input), { code: "invalid_settings", status: 400 });
    }
    assert.deepEqual(await settings.read(), { relativeLineNumbers: true, showKeyboardShortcutIndicators: true, agentVimMode: true, theme: "system" });
});

test("concurrent settings updates are serialized in call order", async () => {
    const { settings } = await fixture();
    await settings.update({ relativeLineNumbers: true });
    await Promise.all([
        settings.update({ relativeLineNumbers: false }),
        settings.update({ relativeLineNumbers: true }),
    ]);
    assert.deepEqual(await settings.read(), { relativeLineNumbers: true, showKeyboardShortcutIndicators: true, agentVimMode: true, theme: "system" });
});

test.each(["{", "null", "[]", '{"relativeLineNumbers":"yes"}', '{"theme":"unknown"}', '{"agentVimMode":"false"}'])(
    "malformed settings %j are surfaced, not overwritten", async (source) => {
        const { path, settings } = await fixture();
        await settings.update({ relativeLineNumbers: true });
        await writeFile(path, source);
        await assert.rejects(settings.read(), { code: "invalid_settings", status: 500 });
        await assert.rejects(settings.update({ relativeLineNumbers: false }), { code: "invalid_settings" });
        assert.equal(await readFile(path, "utf8"), source);
    },
);

test("unknown persisted preferences are retained on update", async () => {
    const { path, settings } = await fixture();
    await settings.update({ relativeLineNumbers: true });
    await writeFile(path, '{"futurePreference": 42}');
    await settings.update({ relativeLineNumbers: true });
    assert.deepEqual(await settings.read(), { futurePreference: 42, relativeLineNumbers: true, showKeyboardShortcutIndicators: true, agentVimMode: true, theme: "system" });
});

test("settings filesystem failures are surfaced", async () => {
    const { path, settings } = await fixture();
    await settings.update({ relativeLineNumbers: true });
    const unwritable = new SettingsStore(join(path, "settings.json"));
    await assert.rejects(unwritable.update({ relativeLineNumbers: true }), (error) => ["ENOTDIR", "EEXIST"].includes(error.code));
});

test("settings HTTP endpoints validate authentication, origin and input", async () => {
    const { root, settings } = await fixture();
    const path = join(root, "note.md");
    await writeFile(path, "# Note\n");
    const store = new DocumentStore(join(root, "drafts"));
    const document = await store.open(path);
    const workspace = await Workspace.create({ filePath: path });
    const entry = await startEditorServer({ store, workspace, document, settings });
    const { call } = apiClient(entry);
    const url = new URL("/api/settings", entry.url);
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await call("settings", undefined, { Origin: "https://example.com" })).status, 403);
    assert.deepEqual(await (await call("settings")).json(), { relativeLineNumbers: false, showKeyboardShortcutIndicators: true, agentVimMode: true, theme: "system" });
    assert.equal((await call("settings", '{"relativeLineNumbers":1}')).status, 400);
    assert.equal((await call("settings", "{}", { "Content-Type": "text/plain" })).status, 415);
    assert.deepEqual(await (await call("settings", '{"relativeLineNumbers":true}')).json(),
        { relativeLineNumbers: true, showKeyboardShortcutIndicators: true, agentVimMode: true, theme: "system" });
    assert.deepEqual(await (await call("settings", '{"theme":"nord"}')).json(),
        { relativeLineNumbers: true, showKeyboardShortcutIndicators: true, agentVimMode: true, theme: "nord" });
    assert.deepEqual(await (await call("settings", '{"showKeyboardShortcutIndicators":false}')).json(),
        { relativeLineNumbers: true, showKeyboardShortcutIndicators: false, agentVimMode: true, theme: "nord" });
    assert.deepEqual(await settings.read(), { relativeLineNumbers: true, showKeyboardShortcutIndicators: false, agentVimMode: true, theme: "nord" });
});

test("agent Vim mode defaults for legacy settings and persists independently", async () => {
    const { path, settings } = await fixture();
    await settings.update({ theme: "system" });
    await writeFile(path, '{"theme":"nord"}');
    assert.equal((await settings.read()).agentVimMode, true);
    await settings.update({ agentVimMode: false });
    await settings.update({ relativeLineNumbers: true });
    assert.deepEqual(await new SettingsStore(path).read(), { theme: "nord", relativeLineNumbers: true, showKeyboardShortcutIndicators: true, agentVimMode: false });
});
