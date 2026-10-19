import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentStore } from "./store.mjs";
import { startServer } from "./server.mjs";
import { Workspace } from "./workspace.mjs";
import { realpath } from "node:fs/promises";

async function until(assertion, timeout = 7000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        try { await assertion(); return; }
        catch (error) { last = error; }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw last;
}

test("browser: Vim editing, preview, saving, recovery, conflicts and layouts", { timeout: 90000 }, async (t) => {
    const root = dirname(fileURLToPath(import.meta.url));
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "vim-markdown-browser-")));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const path = join(temporary, "example.md");
    await writeFile(path, "# Hello\n\nFirst paragraph.\n\n- [ ] Test\n");
    const store = new DocumentStore(join(temporary, "artifacts"));
    const document = await store.open(path);
    await mkdir(join(temporary, "notes", "deep"), { recursive: true });
    const second = join(temporary, "notes", "second.md");
    const nested = join(temporary, "notes", "deep", "nested.md");
    await writeFile(second, "# Second\n\nOther file.\n");
    await writeFile(nested, "# Nested\n");
    const workspace = await Workspace.create({ rootPath: temporary, ignore: ["artifacts"] });
    const entry = await startServer({ store, workspace, document, root });
    t.after(() => entry.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(entry.url);
    await page.locator(".cm-editor").waitFor();
    const mode = () => page.locator("#mode").innerText();
    const state = () => store.snapshot(document);
    const keys = async (sequence) => {
        for (const key of sequence) await page.keyboard.press(key);
    };
    const command = async (value) => {
        await page.keyboard.press(":");
        await page.keyboard.type(value);
        await page.keyboard.press("Enter");
    };

    await t.test("normal/insert modes, live Markdown preview, and :w", async () => {
        assert.equal(await mode(), "NORMAL");
        await page.keyboard.press("i");
        await until(async () => assert.equal(await mode(), "INSERT"));
        await page.keyboard.type("New ");
        await page.keyboard.press("Escape");
        await until(async () => assert.equal(await mode(), "NORMAL"));
        await until(async () => assert.match((await state()).content, /^New # Hello/));
        assert.match(await readFile(path, "utf8"), /^# Hello/);
        await until(async () => assert.match(await page.locator("#preview").innerText(), /^New # Hello/));
        await command("w");
        await until(async () => assert.match(await readFile(path, "utf8"), /^New # Hello/));
        assert.equal((await state()).dirty, false);
    });

    await t.test("text objects, dot repeat, undo, redo, visual selection, search and macros", async () => {
        await keys(["g", "g", "0", "c", "i", "w"]);
        await page.keyboard.type("Changed");
        await page.keyboard.press("Escape");
        await until(async () => assert.match((await state()).content, /^Changed # Hello/));
        const changed = (await state()).content;
        await keys(["u"]);
        await until(async () => assert.notEqual((await state()).content, changed));
        await page.keyboard.press("Control+r");
        await until(async () => assert.equal((await state()).content, changed));
        await keys(["g", "g", "0", "w", "w", "."]);
        await until(async () => assert.match((await state()).content, /^Changed # Changed/));
        await page.keyboard.press("V");
        await until(async () => assert.match(await mode(), /^VISUAL/));
        await page.keyboard.press("Escape");
        await page.keyboard.press("/");
        await page.keyboard.type("paragraph");
        await page.keyboard.press("Enter");
        await until(async () => assert.match(await page.locator("#cursor").innerText(), /^Ln 3,/));
        await page.keyboard.press("Escape");
        await keys(["g", "g", "0", "q", "a", "A"]);
        await page.keyboard.type("!");
        await keys(["Escape", "q", "j", "j", "@", "a"]);
        await until(async () => assert.match((await state()).content, /First paragraph\.!/));
    });

    await t.test("persistent draft recovery and keyboard save", async () => {
        await keys(["G", "A"]);
        await page.keyboard.type(" recovered");
        await page.keyboard.press("Escape");
        await until(async () => assert.match((await state()).content, / recovered/));
        assert.doesNotMatch(await readFile(path, "utf8"), / recovered/);
        await page.reload();
        await page.locator(".cm-editor").waitFor();
        await until(async () => assert.match(await page.locator(".cm-content").innerText(), / recovered/));
        await page.keyboard.press("Control+s");
        await until(async () => assert.match(await readFile(path, "utf8"), / recovered/));
    });

    await t.test("external edits cannot overwrite a dirty draft", async () => {
        await keys(["g", "g", "i"]);
        await page.keyboard.type("Local ");
        await page.keyboard.press("Escape");
        await until(async () => assert.match((await state()).content, /^Local /));
        await writeFile(path, "# External replacement\n");
        await until(async () => assert.equal(await page.locator("#conflict").isVisible(), true));
        assert.equal(await page.locator("#save-button").isDisabled(), true);
        await command("w");
        await until(async () => assert.match(await page.locator("#notice").innerText(), /changed on disk/));
        assert.equal(await readFile(path, "utf8"), "# External replacement\n");
        assert.match((await state()).content, /^Local /);
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator("#reload-button").click();
        await until(async () => assert.equal((await state()).content, "# External replacement\n"));
        await until(async () => assert.equal(await page.locator("#conflict").isVisible(), false));
    });

    await t.test("file explorer: vim keys, mouse, isolation and :e", async () => {
        const rows = () => page.locator("#tree .tree-row");
        const selected = () => page.locator('#tree .tree-row[aria-selected="true"] .tree-label').innerText();
        await until(async () => assert.deepEqual(await rows().locator(".tree-label").allInnerTexts(), ["notes", "example.md"]));
        assert.equal(await page.locator("#tree .tree-row.active .tree-label").innerText(), "example.md");
        assert.deepEqual(await rows().locator(".tree-icon").evaluateAll((icons) => icons.map((item) => item.dataset.icon)), ["folder", "markdown"]);
        assert.equal(await rows().locator('.tree-icon[aria-hidden="true"]').count(), 2);
        assert.equal(await rows().locator(".tree-disclosure.visible").count(), 1);
        await page.locator(".cm-content").click();
        await page.keyboard.press("Escape");
        await keys(["Control+w", "h"]);
        await until(async () => assert.equal(await page.evaluate(() => document.activeElement.id), "tree"));
        await keys(["g", "g"]);
        assert.equal(await selected(), "notes");
        await keys(["l"]);
        await until(async () => assert.deepEqual(await rows().locator(".tree-label").allInnerTexts(), ["notes", "deep", "second.md", "example.md"]));
        assert.deepEqual(await rows().locator(".tree-icon").evaluateAll((icons) => icons.map((item) => item.dataset.icon)), ["folder-open", "folder", "markdown", "markdown"]);
        await keys(["j", "j"]);
        assert.equal(await selected(), "second.md");
        await keys([" "]);
        await until(async () => assert.equal(await page.locator("#filepath").innerText(), second));
        assert.match(await page.locator(".cm-content").innerText(), /Other file/);
        assert.equal(await page.evaluate(() => document.activeElement.id), "tree");
        await keys(["k", "l"]);
        await until(async () => assert.equal(await page.locator('#tree .tree-row[aria-expanded="true"]').count(), 2));
        await keys(["h", "j", "l"]);
        await until(async () => assert.equal(await page.evaluate(() => document.activeElement.classList.contains("cm-content")), true));
        assert.equal(await page.locator("#filepath").innerText(), second);
        await keys(["Control+w", "h"]);
        await until(async () => assert.equal(await page.evaluate(() => document.activeElement.id), "tree"));
        await keys(["Control+w", "l"]);
        await until(async () => assert.equal(await page.evaluate(() => document.activeElement.classList.contains("cm-content")), true));
        await keys(["u"]);
        assert.match(await page.locator(".cm-content").innerText(), /^# Second/);
        await keys(["g", "g", "i"]);
        await page.keyboard.type("Edited ");
        await page.keyboard.press("Escape");
        await page.locator('#tree .tree-row:has-text("example.md")').click();
        await until(async () => assert.equal(await page.locator("#filepath").innerText(), path));
        assert.match((await store.snapshot(await store.open(second))).content, /^Edited # Second/);
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
        await page.locator(".cm-content").click();
    });

    await t.test("sanitized preview, responsive layouts, theme and shortcuts", async () => {
        const snapshot = await state();
        await store.update(document, '# Safe\n\n<script>window.pwned = true</script>\n\n<img src="https://example.com/tracker.png" onerror="window.pwned=true">\n\n<svg onload="window.pwned=true"><script>window.pwned=true</script></svg>\n\n[unsafe](javascript:alert(1))\n\n[external](https://example.com)\n', snapshot.revision);
        await until(async () => assert.equal(await page.locator("#preview h1").innerText(), "Safe"));
        assert.equal(await page.locator("#preview script, #preview img").count(), 0);
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
        await page.setViewportSize({ width: 480, height: 720 });
        assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator(".preview-pane").isVisible(), true);
        await page.emulateMedia({ colorScheme: "dark" });
        assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), true);
    });

    await t.test("GitHub-flavored Markdown preview", async () => {
        const snapshot = await state();
        await page.setViewportSize({ width: 1200, height: 820 });
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
    });

    await t.test("CRLF and Unicode survive actual editor changes", async () => {
        const snapshot = await state();
        await store.reload(document, snapshot.revision, snapshot.diskHash);
        await writeFile(path, "# Café\r\n\r\nGrüße\r\n");
        await page.reload();
        await page.locator(".cm-editor").waitFor();
        await page.keyboard.press("i");
        await page.keyboard.type("Hi ");
        await page.keyboard.press("Escape");
        await command("w");
        await until(async () => assert.equal(await readFile(path, "utf8"), "Hi # Café\r\n\r\nGrüße\r\n"));
    });

    assert.deepEqual(errors, []);
    if (process.env.VIM_CANVAS_SCREENSHOT_DIR) {
        await mkdir(process.env.VIM_CANVAS_SCREENSHOT_DIR, { recursive: true });
        await writeFile(path, await readFile(new URL("./welcome.md", import.meta.url), "utf8"));
        const snapshot = await state();
        await store.reload(document, snapshot.revision, snapshot.diskHash);
        await page.reload();
        await page.locator(".cm-editor").waitFor();
        await page.setViewportSize({ width: 1200, height: 820 });
        await page.emulateMedia({ colorScheme: "light" });
        await page.screenshot({ path: join(process.env.VIM_CANVAS_SCREENSHOT_DIR, "vim-markdown-desktop.png") });
        await page.setViewportSize({ width: 480, height: 720 });
        await page.screenshot({ path: join(process.env.VIM_CANVAS_SCREENSHOT_DIR, "vim-markdown-narrow.png") });
    }
});
