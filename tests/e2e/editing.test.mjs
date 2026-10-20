import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { DocumentStore, Workspace, startEditorServer, tempDir, welcomePath, writeFiles } from "../helpers/fixtures.mjs";
import { exCommand, keyPresser, openEditorPage, until, useBrowser } from "../helpers/browser.mjs";

const browser = useBrowser();
const initialContent = "# Hello\n\nFirst paragraph.\n\n- [ ] Test\n";

/** Fresh workspace (example.md, notes/second.md, notes/deep/nested.md), server and page. */
async function editorPage({ content = initialContent } = {}) {
    const temporary = await tempDir("vim-markdown-browser-");
    const path = join(temporary, "example.md");
    const second = join(temporary, "notes", "second.md");
    const nested = join(temporary, "notes", "deep", "nested.md");
    await writeFiles(temporary, {
        "example.md": content,
        "notes/second.md": "# Second\n\nOther file.\n",
        "notes/deep/nested.md": "# Nested\n",
    });
    const store = new DocumentStore(join(temporary, "artifacts"));
    const document = await store.open(path);
    const workspace = await Workspace.create({ rootPath: temporary, ignore: ["artifacts"] });
    const entry = await startEditorServer({ store, workspace, document });
    const { page, errors } = await openEditorPage(browser(), entry);
    const keys = keyPresser(page);
    return {
        temporary, path, second, nested, store, document, page, errors, keys,
        mode: () => page.locator("#mode").innerText(),
        state: () => store.snapshot(document),
        command: exCommand(page),
    };
}

test("normal/insert modes, immediate disk writes, live preview, and :w", async () => {
    const { path, page, errors, mode, state, command } = await editorPage();
    assert.equal(await mode(), "NORMAL");
    assert.equal(await page.locator("#save-button").count(), 0);
    await page.keyboard.press("i");
    await until(async () => assert.equal(await mode(), "INSERT"));
    await page.keyboard.type("New ");
    await until(async () => assert.match(await readFile(path, "utf8"), /^New # Hello/));
    assert.equal(await mode(), "INSERT");
    await page.keyboard.press("Escape");
    await until(async () => assert.equal(await mode(), "NORMAL"));
    await until(async () => assert.match((await state()).content, /^New # Hello/));
    await until(async () => assert.match(await page.locator("#preview").innerText(), /^New # Hello/));
    await command("w");
    await until(async () => assert.match(await readFile(path, "utf8"), /^New # Hello/));
    await until(async () => assert.equal((await state()).dirty, false));
    assert.deepEqual(errors, []);
});

test("text objects, dot repeat, undo, redo, visual selection, search and macros", async () => {
    // Content as left by the preceding insert scenario in the original sequential suite.
    const { page, errors, keys, mode, state } = await editorPage({ content: `New ${initialContent}` });
    await keys("g", "g", "0", "c", "i", "w");
    await page.keyboard.type("Changed");
    await page.keyboard.press("Escape");
    await until(async () => assert.match((await state()).content, /^Changed # Hello/));
    const changed = (await state()).content;
    await keys("u");
    await until(async () => assert.notEqual((await state()).content, changed));
    await page.keyboard.press("Control+r");
    await until(async () => assert.equal((await state()).content, changed));
    await keys("g", "g", "0", "w", "w", ".");
    await until(async () => assert.match((await state()).content, /^Changed # Changed/));
    await page.keyboard.press("V");
    await until(async () => assert.match(await mode(), /^VISUAL/));
    await page.keyboard.press("Escape");
    await page.keyboard.press("/");
    await page.keyboard.type("paragraph");
    await page.keyboard.press("Enter");
    await until(async () => assert.match(await page.locator("#cursor").innerText(), /^Ln 3,/));
    await page.keyboard.press("Escape");
    await keys("g", "g", "0", "q", "a", "A");
    await page.keyboard.type("!");
    await keys("Escape", "q", "j", "j", "@", "a");
    await until(async () => assert.match((await state()).content, /First paragraph\.!/));
    assert.deepEqual(errors, []);
});

test("automatic saving survives reload and recovered drafts save automatically", async () => {
    const { path, store, document, page, errors, keys, state } = await editorPage();
    await keys("G", "A");
    await page.keyboard.type(" recovered");
    await page.keyboard.press("Escape");
    await until(async () => assert.match((await state()).content, / recovered/));
    await until(async () => assert.match(await readFile(path, "utf8"), / recovered/));
    await until(async () => assert.equal((await state()).dirty, false));
    const snapshot = await state();
    await store.update(document, `${snapshot.content}\nRecovered draft\n`, snapshot.revision);
    await page.reload();
    await page.locator(".cm-editor").waitFor();
    await until(async () => assert.match(await page.locator(".cm-content").innerText(), / recovered/));
    await until(async () => assert.match(await readFile(path, "utf8"), /Recovered draft/));
    assert.deepEqual(errors, []);
});

test("edits during an in-flight save persist without stealing focus", async () => {
    const { path, page, errors, keys, state } = await editorPage();
    let release;
    let started;
    const held = new Promise((resolve) => { release = resolve; });
    const saving = new Promise((resolve) => { started = resolve; });
    await page.route("**/api/save", async (route) => {
        started();
        await held;
        await route.continue();
    }, { times: 1 });
    await keys("g", "g", "i");
    await page.keyboard.type("First ");
    await saving;
    await page.keyboard.type("latest ");
    await page.keyboard.press("Escape");
    await page.locator("#tree").focus();
    release();
    await until(async () => assert.match(await readFile(path, "utf8"), /^First latest /));
    await until(async () => assert.equal((await state()).dirty, false));
    assert.equal(await page.evaluate(() => document.activeElement.id), "tree");
    assert.deepEqual(errors, []);
});

test("failed automatic writes retain the draft and keyboard save retries", async () => {
    const { path, page, errors, keys, state } = await editorPage();
    await page.route("**/api/save", (route) => route.fulfill({
        status: 503, contentType: "application/json",
        body: JSON.stringify({ error: "write_failed", message: "Disk write failed." }),
    }));
    await keys("g", "g", "i");
    await page.keyboard.type("Retry ");
    await page.keyboard.press("Escape");
    await until(async () => assert.match(await page.locator("#notice").innerText(), /Disk write failed/));
    assert.match(await page.locator("#save-status").innerText(), /Not saved/);
    assert.doesNotMatch(await readFile(path, "utf8"), /^Retry /);
    await until(async () => assert.match((await state()).content, /^Retry /));
    await page.unroute("**/api/save");
    await page.keyboard.press("Control+s");
    await until(async () => assert.match(await readFile(path, "utf8"), /^Retry /));
    await until(async () => assert.equal(await page.locator("#save-status").innerText(), "Saved to disk"));
    assert.deepEqual(errors, []);
});

test("external edits automatically replace the open document without a warning", async () => {
    const { path, page, errors, keys, state } = await editorPage();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/save", async (route) => {
        await held;
        await route.continue();
    }, { times: 1 });
    await keys("g", "g", "i");
    await page.keyboard.type("Local ");
    await page.keyboard.press("Escape");
    assert.match(await page.locator(".cm-content").innerText(), /^Local /);
    await writeFile(path, "# External replacement\n");
    release();
    await until(async () => assert.equal((await page.locator(".cm-content").innerText()).trim(), "# External replacement"));
    assert.equal(await readFile(path, "utf8"), "# External replacement\n");
    assert.equal((await state()).content, "# External replacement\n");
    await until(async () => assert.equal(await page.locator("#conflict").isVisible(), false));
    await until(async () => assert.equal(await page.locator("#notice").isVisible(), false));
    assert.equal(await page.locator("#save-status").innerText(), "Saved to disk");
    assert.deepEqual(errors, []);
});

test("file explorer: vim keys, mouse, isolation and :e", async () => {
    const { path, second, nested, store, page, errors, keys, command } = await editorPage();
    const rows = () => page.locator("#tree .tree-row");
    const selected = () => page.locator('#tree .tree-row[aria-selected="true"] .tree-label').innerText();
    await until(async () => assert.deepEqual(await rows().locator(".tree-label").allInnerTexts(), ["notes", "example.md"]));
    assert.equal(await page.locator("#tree .tree-row.active .tree-label").innerText(), "example.md");
    assert.deepEqual(await rows().locator(".tree-icon").evaluateAll((icons) => icons.map((item) => item.dataset.icon)), ["folder", "markdown"]);
    assert.equal(await rows().locator('.tree-icon[aria-hidden="true"]').count(), 2);
    assert.equal(await rows().locator(".tree-disclosure.visible").count(), 1);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Escape");
    await keys("Control+w", "h");
    await until(async () => assert.equal(await page.evaluate(() => document.activeElement.id), "tree"));
    await keys("g", "g");
    assert.equal(await selected(), "notes");
    await keys("l");
    await until(async () => assert.deepEqual(await rows().locator(".tree-label").allInnerTexts(), ["notes", "deep", "second.md", "example.md"]));
    assert.deepEqual(await rows().locator(".tree-icon").evaluateAll((icons) => icons.map((item) => item.dataset.icon)), ["folder-open", "folder", "markdown", "markdown"]);
    await keys("j", "j");
    assert.equal(await selected(), "second.md");
    await keys(" ");
    await until(async () => assert.equal(await page.locator("#filepath").innerText(), second));
    assert.match(await page.locator(".cm-content").innerText(), /Other file/);
    assert.equal(await page.evaluate(() => document.activeElement.id), "tree");
    await keys("k", "l");
    await until(async () => assert.equal(await page.locator('#tree .tree-row[aria-expanded="true"]').count(), 2));
    await keys("h", "j", "l");
    await until(async () => assert.equal(await page.evaluate(() => document.activeElement.classList.contains("cm-content")), true));
    assert.equal(await page.locator("#filepath").innerText(), second);
    await keys("Control+w", "h");
    await until(async () => assert.equal(await page.evaluate(() => document.activeElement.id), "tree"));
    await keys("Control+w", "l");
    await until(async () => assert.equal(await page.evaluate(() => document.activeElement.classList.contains("cm-content")), true));
    await keys("u");
    assert.match(await page.locator(".cm-content").innerText(), /^# Second/);
    await keys("g", "g", "i");
    await page.keyboard.type("Edited ");
    await page.keyboard.press("Escape");
    await page.locator('#tree .tree-row:has-text("example.md")').click();
    await until(async () => assert.equal(await page.locator("#filepath").innerText(), path));
    assert.match((await store.snapshot(await store.open(second))).content, /^Edited # Second/);
    assert.match(await readFile(second, "utf8"), /^Edited # Second/);
    await page.locator('#tree .tree-row:has-text("deep")').click();
    await until(async () => assert.equal(await rows().filter({ hasText: "nested.md" }).count(), 1));
    await page.locator('#tree .tree-row:has-text("nested.md")').dblclick();
    await until(async () => assert.equal(await page.locator("#filepath").innerText(), nested));
    await until(async () => assert.equal(await page.evaluate(() => document.activeElement.classList.contains("cm-content")), true));
    await command("e notes/second.md");
    await until(async () => assert.match(await page.locator(".cm-content").innerText(), /^Edited # Second/));
    await command("e ../outside.md");
    await until(async () => assert.match(await page.locator("#notice").innerText(), /outside/i));
    await page.locator("#dismiss-notice").click();
    await page.locator(".cm-content").click();
    await command("Lex");
    assert.equal(await page.locator("#explorer").isVisible(), false);
    await command("Lex");
    await until(async () => assert.equal(await page.locator("#explorer").isVisible(), true));
    await until(async () => assert.equal(await page.evaluate(() => document.activeElement.id), "tree"));
    await page.keyboard.press("q");
    assert.equal(await page.locator("#explorer").isVisible(), false);
    await page.locator("#toggle-explorer").click();
    await page.locator('#tree .tree-row:has-text("example.md")').click();
    await until(async () => assert.equal(await page.locator("#filepath").innerText(), path));
    assert.deepEqual(errors, []);
});

test("collapsing and reopening the explorer preserves workspace geometry", async () => {
    const { page, errors } = await editorPage();
    for (const width of [1200, 701, 700, 480]) {
        await page.setViewportSize({ width, height: 820 });
        for (const layout of ["edit", "split", "preview"]) {
            await page.locator(`button[data-layout="${layout}"]`).click();
            for (const open of [false, true, false]) {
                if (await page.locator("#toggle-explorer").getAttribute("aria-pressed") !== String(open)) {
                    await page.locator("#toggle-explorer").click();
                }
                await until(async () => {
                    const bounds = await page.evaluate(() => {
                        const rect = (selector) => {
                            const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
                            return { x, y, width, height };
                        };
                        return {
                            shell: rect("#shell"), workspace: rect("#workspace"),
                            explorer: rect("#explorer"), handle: rect("#resize-explorer"),
                            editor: rect(".editor-pane"), preview: rect(".preview-pane"),
                        };
                    });
                    const context = `${width}px, ${layout}, explorer ${open ? "open" : "closed"}`;
                    const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1,
                        `${context}: expected ${expected}, got ${actual}`);
                    const inset = open && width > 700 ? bounds.explorer.width + bounds.handle.width : 0;
                    close(bounds.workspace.x, bounds.shell.x + inset);
                    close(bounds.workspace.y, bounds.shell.y);
                    close(bounds.workspace.width, bounds.shell.width - inset);
                    close(bounds.workspace.height, bounds.shell.height);
                    for (const pane of layout === "split" ? ["editor", "preview"] : [layout === "edit" ? "editor" : "preview"]) {
                        close(bounds[pane].width, bounds.workspace.width / (layout === "split" && width > 700 ? 2 : 1));
                        close(bounds[pane].height, bounds.workspace.height / (layout === "split" && width <= 700 ? 2 : 1));
                    }
                });
            }
        }
    }
    assert.deepEqual(errors, []);
});

test("sanitized preview, responsive layouts, theme and shortcuts", async () => {
    const { store, document, page, errors, state } = await editorPage();
    const snapshot = await state();
    await store.update(document, '# Safe\n\n<script>window.pwned = true</script>\n\n<img src="https://example.com/tracker.png" onerror="window.pwned=true">\n\n<svg onload="window.pwned=true"><script>window.pwned=true</script></svg>\n\n[unsafe](javascript:alert(1))\n\n[external](https://example.com)\n', snapshot.revision);
    await until(async () => assert.equal(await page.locator("#preview h1").innerText(), "Safe"));
    await until(async () => assert.equal(await page.locator("#preview script, #preview img").count(), 0));
    assert.equal(await page.locator("#preview svg, #preview [onload], #preview [onerror]").count(), 0);
    assert.equal(await page.locator("#preview a[href^='javascript:']").count(), 0);
    assert.equal(await page.locator("#preview a").filter({ hasText: "unsafe" }).getAttribute("href"), null);
    assert.equal(await page.locator("#preview a[href^='https://example.com']").getAttribute("rel"), "noopener noreferrer");
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    await page.locator('[data-layout="preview"]').click();
    assert.equal(await page.locator(".editor-pane").isVisible(), false);
    await page.locator('[data-layout="edit"]').click();
    assert.equal(await page.locator(".preview-pane").isVisible(), false);
    await page.locator('[data-layout="split"]').click();
    await page.locator("#help-button").click();
    assert.equal(await page.locator("#help").isVisible(), true);
    await page.locator("#close-help").click();
    const headingColor = () => page.locator(".cm-line span").filter({ hasText: "Safe" }).first().evaluate((node) => getComputedStyle(node).color);
    await page.emulateMedia({ colorScheme: "light" });
    await until(async () => assert.equal(await headingColor(), "rgb(5, 80, 174)"));
    await page.emulateMedia({ colorScheme: "dark" });
    await until(async () => assert.equal(await headingColor(), "rgb(121, 192, 255)"));
    await page.evaluate(() => { document.documentElement.dataset.colorMode = "light"; });
    await until(async () => assert.equal(await headingColor(), "rgb(5, 80, 174)"));
    await page.evaluate(() => { delete document.documentElement.dataset.colorMode; });
    await until(async () => assert.equal(await headingColor(), "rgb(121, 192, 255)"));
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 480, height: 720 });
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator(".preview-pane").isVisible(), true);
    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), true);
    assert.deepEqual(errors, []);
});

test("GitHub-flavored Markdown preview and production hash-token fragment links", async () => {
    const { store, document, page, errors, state } = await editorPage();
    const snapshot = await state();
    const gfm = [
        "# Title", "", "## Section Two", "",
        "- [x] done", "- [ ] todo", "",
        "~~gone~~ www.example.com", "",
        "| L | C | R |", "|:--|:-:|--:|", "| 1 | 2 | 3 |", "",
        "> [!WARNING]", "> Careful.", "",
        "See note[^1] and [jump](#section-two).", "",
        "[^1]: The footnote.", "",
        "<textarea>raw</textarea>", "",
    ].join("\n");
    await store.update(document, gfm, snapshot.revision);
    const preview = page.locator("#preview");
    await until(async () => assert.equal(await preview.locator("h1").innerText(), "Title"));
    assert.equal(await preview.locator("h1").getAttribute("id"), "user-content-title");
    assert.equal(await preview.locator('input[type="checkbox"][disabled]').count(), 2);
    assert.equal(await preview.locator('input[type="checkbox"]:checked').count(), 1);
    assert.equal(await preview.locator("del").innerText(), "gone");
    assert.equal(await preview.locator('a[href="http://www.example.com"]').count(), 1);
    assert.equal(await preview.locator("td").nth(1).evaluate((cell) => getComputedStyle(cell).textAlign), "center");
    assert.equal(await preview.locator("td").nth(2).evaluate((cell) => getComputedStyle(cell).textAlign), "right");
    assert.equal(await preview.locator(".markdown-alert-warning .markdown-alert-title").innerText(), "Warning");
    assert.equal(await preview.locator("section.footnotes li").count(), 1);
    assert.match(await preview.locator("section.footnotes").innerText(), /The footnote\./);
    assert.equal(await preview.locator("textarea").count(), 0);
    const hash = await page.evaluate(() => location.hash);
    await preview.locator('a[href="#section-two"]').click();
    assert.equal(await page.evaluate(() => location.hash), hash);
    assert.deepEqual(errors, []);
});

test("CRLF and Unicode survive actual editor changes", async () => {
    const { path, page, errors, command } = await editorPage({ content: "# Café\r\n\r\nGrüße\r\n" });
    await page.keyboard.press("i");
    await page.keyboard.type("Hi ");
    await page.keyboard.press("Escape");
    await command("w");
    await until(async () => assert.equal(await readFile(path, "utf8"), "Hi # Café\r\n\r\nGrüße\r\n"));
    assert.deepEqual(errors, []);
});

test.skipIf(!process.env.VIM_CANVAS_SCREENSHOT_DIR)("welcome document screenshots (VIM_CANVAS_SCREENSHOT_DIR)", async () => {
    const directory = process.env.VIM_CANVAS_SCREENSHOT_DIR;
    const { page, errors } = await editorPage({ content: await readFile(welcomePath, "utf8") });
    await mkdir(directory, { recursive: true });
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: join(directory, "vim-markdown-desktop.png") });
    await page.setViewportSize({ width: 480, height: 720 });
    await page.screenshot({ path: join(directory, "vim-markdown-narrow.png") });
    assert.deepEqual(errors, []);
});
