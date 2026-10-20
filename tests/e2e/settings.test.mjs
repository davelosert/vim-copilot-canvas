import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { DocumentStore, SettingsStore, Workspace, startEditorServer, tempDir } from "../helpers/fixtures.mjs";
import { openEditorPage, until, useBrowser } from "../helpers/browser.mjs";

const browser = useBrowser();
const source = "# One\nTwo\nThree\nFour\nFive";

/** Fresh note/other workspace with a temporary settings file; `start()` starts another server on it. */
async function settingsPage({ content = source, preferences } = {}) {
    const temporary = await tempDir("vim-settings-browser-");
    const path = join(temporary, "note.md");
    await writeFile(path, content);
    await writeFile(join(temporary, "other.txt"), "First\nSecond\nThird");
    const settingsFile = join(temporary, "preferences", "settings.json");
    if (preferences) {
        await mkdir(join(temporary, "preferences"));
        await writeFile(settingsFile, JSON.stringify(preferences));
    }
    const store = new DocumentStore(join(temporary, "drafts"));
    const document = await store.open(path);
    const workspace = await Workspace.create({ filePath: path, ignore: ["drafts"] });
    const start = () => startEditorServer({ store, workspace, document, settings: new SettingsStore(settingsFile) });
    const entry = await start();
    const { page, errors } = await openEditorPage(browser(), entry);
    const numbers = () => page.locator(".cm-lineNumbers .cm-gutterElement").evaluateAll((elements) =>
        elements.filter((element) => getComputedStyle(element).visibility !== "hidden").map((element) => element.textContent));
    const toggle = async (enabled) => {
        const originalCursor = await page.locator("#cursor").innerText();
        await page.locator("#settings-button").click();
        await until(async () => assert.equal(await page.locator("#relative-line-numbers").isEnabled(), true));
        assert.equal(await page.locator("#cursor").innerText(), originalCursor, "opening settings preserves cursor");
        await page.locator("#relative-line-numbers").setChecked(enabled);
        await until(async () => assert.equal(await page.locator("#settings-status").innerText(), "Settings saved."));
        assert.equal(await page.locator("#cursor").innerText(), originalCursor, "saving settings preserves cursor");
        await page.locator("#close-settings").click();
        await until(async () => assert.equal(await page.evaluate(() => document.activeElement.id), "settings-button"));
    };
    const settingsButton = page.getByRole("button", { name: "Open settings", exact: true });
    return { temporary, path, settingsFile, start, page, errors, numbers, toggle, settingsButton };
}

test("toolbar displays the Modal V logo and hides it on narrow viewports", async () => {
    const { page, errors } = await settingsPage();
    const logo = page.locator(".logo");
    assert.equal(await logo.isVisible(), true);
    assert.equal(await logo.getAttribute("aria-hidden"), "true");
    assert.equal(await logo.innerText(), "");
    const svg = logo.locator("svg");
    assert.equal(await svg.getAttribute("viewBox"), "0 0 32 32");
    assert.equal(await svg.locator("path").count(), 2);
    assert.deepEqual(await svg.evaluate((node) => {
        const { width, height } = node.getBoundingClientRect();
        return { width, height };
    }), { width: 32, height: 32 });
    await page.setViewportSize({ width: 480, height: 720 });
    assert.equal(await logo.isVisible(), false);
    assert.deepEqual(errors, []);
});

test("settings dialog exposes its controls and fits narrow viewports", async () => {
    const { page, errors, settingsButton } = await settingsPage();
    assert.equal(await settingsButton.locator('svg[aria-hidden="true"]').isVisible(), true);
    assert.equal(await settingsButton.evaluate((button) => button === button.parentElement.lastElementChild), true);
    await settingsButton.click();
    assert.equal(await page.getByRole("dialog", { name: "Settings", exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("checkbox", { name: "Relative line numbers", exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel("Editor theme").inputValue(), "system");
    assert.equal(await page.locator("#editor-theme option").count(), 15);
    await page.keyboard.press("Escape");
    await until(async () => assert.equal(await page.locator("#settings").isVisible(), false));
    await page.setViewportSize({ width: 480, height: 720 });
    assert.equal(await settingsButton.isVisible(), true);
    await settingsButton.click();
    assert.equal(await page.getByRole("dialog", { name: "Settings", exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    assert.deepEqual(errors, []);
});

test("relative numbers and theme changes persist without resetting mode, cursor, text or undo", async () => {
    const { path, settingsFile, page, errors, numbers, toggle } = await settingsPage();
    await page.locator(".cm-line").first().click({ position: { x: 15, y: 5 } });
    await page.keyboard.press("0");
    assert.deepEqual(await numbers(), ["1", "2", "3", "4", "5"]);
    await page.keyboard.press("3");
    await page.keyboard.press("G");
    const cursor = await page.locator("#cursor").innerText();
    await page.keyboard.press("i");
    await page.keyboard.type("Edited ");
    await until(async () => assert.match(await readFile(path, "utf8"), /Edited Three/));
    await toggle(true);
    await page.locator("#settings-button").click();
    await page.locator("#editor-theme").selectOption("dracula");
    await until(async () => assert.equal(await page.locator("#settings-status").innerText(), "Settings saved."));
    assert.equal(await page.locator(".cm-editor").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(40, 42, 54)");
    await page.locator("#close-settings").click();
    await until(async () => assert.equal((await readFile(settingsFile, "utf8")).includes('"theme": "dracula"'), true));
    await page.locator("#settings-button").click();
    assert.equal(await page.locator("#editor-theme").inputValue(), "dracula");
    await page.locator("#close-settings").click();
    assert.deepEqual(errors, []);
    assert.equal(await page.locator("#mode").innerText(), "INSERT");
    assert.equal(await page.locator("#cursor").innerText(), cursor.replace("Col 1", "Col 8"));
    assert.match(await page.locator(".cm-content").innerText(), /Edited Three/);
    await until(async () => assert.deepEqual(await numbers(), ["2", "1", "3", "1", "2"]));
    await page.locator(".cm-line").nth(2).click();
    await page.keyboard.press("Escape");
    await until(async () => assert.equal(await page.locator("#mode").innerText(), "NORMAL"));
    await page.keyboard.press("u");
    await until(async () => assert.equal(await readFile(path, "utf8"), source));
    await page.keyboard.press("3");
    await page.keyboard.press("G");
    await page.keyboard.press("j");
    await until(async () => assert.deepEqual(await numbers(), ["3", "2", "1", "4", "1"]));
    await page.keyboard.press("o");
    await page.keyboard.type("Inserted");
    await page.keyboard.press("Escape");
    await until(async () => assert.deepEqual(await numbers(), ["4", "3", "2", "1", "5", "1"]));
    await until(async () => assert.match(await readFile(path, "utf8"), /Inserted/));
    assert.deepEqual(errors, []);
});

// Six lines with relative numbers enabled: the state left by the preceding scenario in the original suite.
const sixLines = "# One\nTwo\nThree\nFour\nInserted\nFive";

test("persisted relative numbers apply after reload and to other files", async () => {
    const { page, errors, numbers } = await settingsPage({ content: sixLines, preferences: { relativeLineNumbers: true, theme: "dracula" } });
    await page.reload();
    await page.locator(".cm-editor").waitFor();
    await until(async () => assert.deepEqual(await numbers(), ["1", "1", "2", "3", "4", "5"]));
    await page.locator("#tree .tree-label").getByText("other.txt", { exact: true }).click();
    await until(async () => assert.equal(await page.locator("#filetype").innerText(), "Plain text"));
    await until(async () => assert.deepEqual(await numbers(), ["1", "1", "2"]));
    await page.locator(".cm-content").click();
    await page.keyboard.press("G");
    await until(async () => assert.deepEqual(await numbers(), ["2", "1", "3"]));
    assert.deepEqual(errors, []);
});

test("failed settings writes keep the previous preference and document state", async () => {
    const { page, errors, numbers } = await settingsPage({ content: sixLines, preferences: { relativeLineNumbers: true, theme: "dracula" } });
    await page.locator("#tree .tree-label").getByText("other.txt", { exact: true }).click();
    await until(async () => assert.equal(await page.locator("#filetype").innerText(), "Plain text"));
    await page.locator(".cm-content").click();
    await page.keyboard.press("G");
    await until(async () => assert.deepEqual(await numbers(), ["2", "1", "3"]));
    await page.route("**/api/settings", (route) => route.request().method() === "POST"
        ? route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"Settings disk is unavailable."}' })
        : route.continue());
    await page.locator("#settings-button").click();
    await until(async () => assert.equal(await page.locator("#relative-line-numbers").isEnabled(), true));
    await page.locator("#relative-line-numbers").uncheck();
    await until(async () => assert.match(await page.locator("#settings-status").innerText(), /Settings disk is unavailable/));
    assert.equal(await page.locator("#relative-line-numbers").isChecked(), true);
    assert.equal(await page.locator("#save-status").innerText(), "Saved to disk");
    assert.deepEqual(await numbers(), ["2", "1", "3"]);
    await page.locator("#close-settings").click();
    await page.unroute("**/api/settings");
    assert.deepEqual(errors, []);
});

test("settings persist across server instances and can be disabled again", async () => {
    const { settingsFile, start, page, errors, numbers, toggle } = await settingsPage({ content: sixLines });
    await toggle(true);
    await until(async () => assert.deepEqual(await numbers(), ["1", "1", "2", "3", "4", "5"]));
    const reopened = await start();
    await page.goto(reopened.url);
    await page.locator(".cm-editor").waitFor();
    await until(async () => assert.deepEqual(await numbers(), ["1", "1", "2", "3", "4", "5"]));
    await toggle(false);
    await until(async () => assert.deepEqual(await numbers(), ["1", "2", "3", "4", "5", "6"]));
    await page.reload();
    await page.locator(".cm-editor").waitFor();
    assert.deepEqual(await numbers(), ["1", "2", "3", "4", "5", "6"]);
    assert.equal(JSON.parse(await readFile(settingsFile, "utf8")).relativeLineNumbers, false);
    assert.deepEqual(errors, []);
});
