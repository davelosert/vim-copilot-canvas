import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsStore, settingsPath } from "./settings.mjs";
import { DocumentStore } from "./store.mjs";
import { startServer } from "./server.mjs";
import { Workspace } from "./workspace.mjs";

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "vim-settings-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = settingsPath(root);
    return { root, path, settings: new SettingsStore(path) };
}

test("settings use the standard global canvas artifacts directory", () => {
    assert.equal(settingsPath("/custom/copilot"), "/custom/copilot/extensions/vim-markdown/artifacts/settings.json");
    assert.equal(settingsPath(), join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions", "vim-markdown", "artifacts", "settings.json"));
});

test("settings default to absolute numbers and the system theme, and persist across stores", async (t) => {
    const { path, settings } = await fixture(t);
    assert.deepEqual(await settings.read(), { relativeLineNumbers: false, theme: "system" });
    await settings.update({ relativeLineNumbers: true });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { relativeLineNumbers: true, theme: "system" });
    await settings.update({ theme: "dracula" });
    const reopened = new SettingsStore(path);
    assert.deepEqual(await reopened.read(), { relativeLineNumbers: true, theme: "dracula" });
    await reopened.update({ relativeLineNumbers: false });
    assert.deepEqual(await settings.read(), { relativeLineNumbers: false, theme: "dracula" });
    assert.deepEqual(await readdir(dirname(path)), ["settings.json"]);
});

test("settings reject invalid updates without changing persisted preferences", async (t) => {
    const { settings } = await fixture(t);
    await settings.update({ relativeLineNumbers: true });
    for (const input of [null, [], {}, true, { relativeLineNumbers: "true" }, { theme: "unknown" }, { relativeLineNumbers: false, other: true }]) {
        await assert.rejects(settings.update(input), { code: "invalid_settings", status: 400 });
    }
    assert.deepEqual(await settings.read(), { relativeLineNumbers: true, theme: "system" });
    await Promise.all([
        settings.update({ relativeLineNumbers: false }),
        settings.update({ relativeLineNumbers: true }),
    ]);
    assert.deepEqual(await settings.read(), { relativeLineNumbers: true, theme: "system" });
});

test("malformed settings and filesystem failures are surfaced, not overwritten", async (t) => {
    const { path, settings } = await fixture(t);
    await settings.update({ relativeLineNumbers: true });
    for (const source of ["{", "null", "[]", '{"relativeLineNumbers":"yes"}', '{"theme":"unknown"}']) {
        await writeFile(path, source);
        await assert.rejects(settings.read(), { code: "invalid_settings", status: 500 });
        await assert.rejects(settings.update({ relativeLineNumbers: false }), { code: "invalid_settings" });
        assert.equal(await readFile(path, "utf8"), source);
    }
    await writeFile(path, '{"futurePreference": 42}');
    await settings.update({ relativeLineNumbers: true });
    assert.deepEqual(await settings.read(), { futurePreference: 42, relativeLineNumbers: true, theme: "system" });
    const unwritable = new SettingsStore(join(path, "settings.json"));
    await assert.rejects(unwritable.update({ relativeLineNumbers: true }), { code: "ENOTDIR" });
});

test("settings HTTP endpoints validate authentication, origin and input", async (t) => {
    const { root, settings } = await fixture(t);
    const path = join(root, "note.md");
    await writeFile(path, "# Note\n");
    const store = new DocumentStore(join(root, "drafts"));
    const document = await store.open(path);
    const workspace = await Workspace.create({ filePath: path });
    const entry = await startServer({ store, workspace, document, settings, root: dirname(fileURLToPath(import.meta.url)) });
    t.after(() => entry.close());
    const url = new URL("/api/settings", entry.url);
    const headers = { "X-Editor-Token": new URL(entry.url).hash.slice(1), "Content-Type": "application/json" };
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: "https://example.com" } })).status, 403);
    assert.deepEqual(await (await fetch(url, { headers })).json(), { relativeLineNumbers: false, theme: "system" });
    assert.equal((await fetch(url, { method: "POST", headers, body: '{"relativeLineNumbers":1}' })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "{}" })).status, 415);
    assert.deepEqual(await (await fetch(url, {
        method: "POST", headers, body: '{"relativeLineNumbers":true}',
    })).json(), { relativeLineNumbers: true, theme: "system" });
    assert.deepEqual(await (await fetch(url, {
        method: "POST", headers, body: '{"theme":"nord"}',
    })).json(), { relativeLineNumbers: true, theme: "nord" });
    assert.deepEqual(await settings.read(), { relativeLineNumbers: true, theme: "nord" });
});
