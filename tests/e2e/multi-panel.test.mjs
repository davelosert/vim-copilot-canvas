import { expect, onTestFinished, test } from "vitest";
import { chromium } from "playwright";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentStore } from "../../src/backend/document-store.mjs";
import { SettingsStore } from "../../src/backend/settings-store.mjs";
import { startServer } from "../../src/backend/server.mjs";
import { Workspace } from "../../src/backend/workspace.mjs";

async function panels() {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "vim-panels-")));
    let browser;
    let entry;
    onTestFinished(async () => {
        await browser?.close();
        await entry?.close();
        await rm(directory, { recursive: true, force: true });
    });
    const path = join(directory, "first.md");
    const second = join(directory, "second.md");
    await writeFile(path, "# First\n");
    await writeFile(second, "# Second\n");
    const store = new DocumentStore(join(directory, "artifacts"));
    const document = await store.open(path);
    const workspace = await Workspace.create({ rootPath: directory, ignore: ["artifacts"] });
    entry = await startServer({
        store, document, workspace,
        root: fileURLToPath(new URL("../../", import.meta.url)),
        settings: new SettingsStore(join(directory, "settings.json")),
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const first = await context.newPage();
    const other = await context.newPage();
    await Promise.all([first.goto(entry.url), other.goto(entry.url)]);
    await Promise.all([
        first.locator("#editor .cm-content").waitFor(),
        other.locator("#editor .cm-content").waitFor(),
    ]);
    return { path, second, store, document, entry, first, other };
}

async function prepend(page, text) {
    await page.locator("#editor .cm-content").focus();
    for (const key of ["Escape", "g", "g", "0", "i"]) await page.keyboard.press(key);
    await page.keyboard.type(text);
    await page.keyboard.press("Escape");
}

test("production panels follow SDK-directed switches and adopt clean external edits", async () => {
    const { path, second, entry, first, other } = await panels();
    const token = new URL(first.url()).hash;
    await writeFile(path, "# Changed on disk\n");
    await expect.poll(() => other.locator("#editor .cm-content").innerText(), { timeout: 8000 }).toContain("Changed on disk");
    await entry.openFile(second);
    await expect.poll(() => first.locator("#filepath").innerText(), { timeout: 8000 }).toBe(second);
    await expect.poll(() => other.locator("#filepath").innerText(), { timeout: 8000 }).toBe(second);
    await expect.poll(() => first.locator("#preview h1").innerText()).toBe("Second");
    expect(new URL(first.url()).hash).toBe(token);
    expect(new URL(other.url()).hash).toBe(token);
}, 30000);

test("a stale production panel preserves local text without overwriting the newer draft", async () => {
    const { path, store, document, first, other } = await panels();
    const initial = await store.snapshot(document);
    await other.route("**/api/document?path=**", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...initial, activePath: path }),
    }));
    await prepend(first, "Newer ");
    await expect.poll(() => readFile(path, "utf8"), { timeout: 8000 }).toBe("Newer # First\n");
    await prepend(other, "Unsynced ");
    await expect.poll(() => other.locator("#save-status").innerText(), { timeout: 8000 }).toBe("Draft conflict");
    expect(await other.locator("#editor .cm-content").innerText()).toContain("Unsynced # First");
    expect(await readFile(path, "utf8")).toBe("Newer # First\n");
    expect((await store.snapshot(document)).content).toBe("Newer # First\n");
    await other.locator("#editor .cm-content").focus();
    await other.keyboard.press("Control+s");
    await expect.poll(() => other.locator("#notice-text").innerText()).toMatch(/conflict|another panel|local text is preserved/i);
    expect(await readFile(path, "utf8")).toBe("Newer # First\n");
}, 30000);
