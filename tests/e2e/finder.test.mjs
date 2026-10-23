import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { DocumentStore, Workspace, startEditorServer, tempDir, writeFiles } from "../helpers/fixtures.mjs";
import { exCommand, openEditorPage, until, useBrowser } from "../helpers/browser.mjs";

const browser = useBrowser();
const git = promisify(execFile);

async function finderPage() {
    const temporary = await tempDir("vim-markdown-finder-");
    await writeFiles(temporary, {
        "example.md": "# Example\n",
        "notes/second.md": "# Second\n",
        "notes/deep/nested.md": "# Nested\n",
        "build/output.md": "# Ignored\n",
        ".gitignore": "build/\nartifacts/\n",
    });
    await git("git", ["init", "-q"], { cwd: temporary });
    const store = new DocumentStore(join(temporary, "artifacts"));
    const document = await store.open(join(temporary, "example.md"));
    const workspace = await Workspace.create({ rootPath: temporary, ignore: ["artifacts"] });
    const entry = await startEditorServer({ store, workspace, document });
    const { page, errors } = await openEditorPage(browser(), entry);
    const rows = () => page.locator("#finder-list [role=option]").evaluateAll((items) => items.map((item) => item.dataset.path));
    const openedName = () => page.locator("#filename").innerText();
    return { temporary, page, errors, rows, openedName, command: exCommand(page) };
}

test("fuzzy finder opens files from every entry point, hides ignored files and lists recents first", async () => {
    const { page, errors, rows, openedName, command } = await finderPage();
    const finder = page.locator("#finder");
    const input = page.getByRole("combobox", { name: "Search files by name" });

    await page.keyboard.press("ControlOrMeta+p");
    await until(async () => assert.equal(await finder.evaluate((node) => node.open), true));
    await until(async () => assert.deepEqual(await rows(), ["example.md", ".gitignore", "notes/deep/nested.md", "notes/second.md"]));
    await input.fill("ndnest");
    await until(async () => assert.deepEqual(await rows(), ["notes/deep/nested.md"]));
    await page.keyboard.press("Enter");
    await until(async () => assert.equal(await openedName(), "nested.md"));
    assert.equal(await finder.evaluate((node) => node.open), false);

    await command("Files");
    await until(async () => assert.equal(await input.evaluate((node) => node === document.activeElement), true));
    await until(async () => assert.deepEqual((await rows()).slice(0, 2), ["notes/deep/nested.md", "example.md"]));
    await input.fill("output");
    await until(async () => assert.match(await page.locator("#finder-status").innerText(), /No matching files/));
    await input.fill("second");
    await page.keyboard.press("Enter");
    await until(async () => assert.equal(await openedName(), "second.md"));

    await page.keyboard.press(" ");
    await page.keyboard.press("f");
    await until(async () => assert.deepEqual((await rows()).slice(0, 3), ["notes/second.md", "notes/deep/nested.md", "example.md"]));
    await page.keyboard.press("Escape");
    await until(async () => assert.equal(await finder.evaluate((node) => node.open), false));

    await page.locator("#tree").focus();
    await page.keyboard.press("f");
    await until(async () => assert.equal(await finder.evaluate((node) => node.open), true));
    await input.fill("exmd");
    await page.keyboard.press("Enter");
    await until(async () => assert.equal(await openedName(), "example.md"));
    assert.deepEqual(errors, []);
});
