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

test("browser: Send to Agent captures cursor and Visual selections and groups reviews", { timeout: 90000 }, async (t) => {
    const root = dirname(fileURLToPath(import.meta.url));
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "vim-markdown-agent-")));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const path = join(temporary, "example.md");
    const content = "First line\nSecond line\nThird line\n";
    await writeFile(path, content);
    const second = join(temporary, "second.md");
    await writeFile(second, "# Second\n");
    const store = new DocumentStore(join(temporary, "artifacts"));
    const document = await store.open(path);
    const workspace = await Workspace.create({ rootPath: temporary, ignore: ["artifacts"] });
    const messages = [];
    let fail = false;
    const entry = await startServer({
        store, workspace, document, root,
        sendMessage: async (message) => {
            if (fail) throw new Error("Session disconnected");
            messages.push(message);
            return `message-${messages.length}`;
        },
    });
    t.after(() => entry.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(entry.url);
    await page.locator(".cm-editor").waitFor();
    const prompt = page.getByRole("textbox", { name: "Agent prompt" });
    const promptText = async () => (await prompt.locator(".cm-line").allInnerTexts()).join("\n");
    const keys = async (...sequence) => {
        for (const key of sequence) await page.keyboard.press(key);
    };
    const open = async () => {
        await page.keyboard.press("Control+i");
        await prompt.waitFor();
        assert.equal(await prompt.evaluate((node) => node === document.activeElement), true);
        assert.equal(await page.locator(".agent-header .mode").innerText(), "INSERT");
    };
    const send = async (text) => {
        await page.keyboard.type(text);
        await page.keyboard.press("Enter");
        await until(async () => assert.equal(await prompt.count(), 0));
    };
    await t.test("cursor line, inline placement, newline, no duplicates and focus restoration", async () => {
        await keys("j");
        await open();
        const position = await page.locator(".agent-prompt").boundingBox();
        const editorBounds = await page.locator("#editor").boundingBox();
        assert.ok(position.y > editorBounds.y && position.y < editorBounds.y + editorBounds.height);
        await page.keyboard.press("Enter");
        assert.equal(messages.length, 0);
        await page.keyboard.type("Explain");
        await keys("Shift+Enter");
        await page.keyboard.type("this");
        assert.equal(await promptText(), "Explain\nthis");
        await keys("Control+i");
        assert.equal(await prompt.count(), 1);
        await keys("Enter", "Enter");
        await until(async () => assert.equal(await prompt.count(), 0));
        assert.equal(messages.length, 1);
        assert.equal(messages[0].prompt, "Explain\nthis");
        assert.deepEqual(messages[0].attachments, [{
            type: "selection", filePath: path, displayName: "example.md:2",
            selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 11 } },
            text: "Second line",
        }]);
        assert.equal(await page.locator(".cm-content").evaluate((node) => node === document.activeElement), true);
    });
    await t.test("forward and backward Visual line selections preserve CodeMirror's range", async () => {
        for (const sequence of [["g", "g", "V", "j"], ["Escape", "g", "g", "j", "V", "k"]]) {
            await keys(...sequence);
            await open();
            await send("Rewrite selected lines");
            const attachment = messages.at(-1).attachments[0];
            assert.deepEqual(attachment.selection, { start: { line: 0, character: 0 }, end: { line: 1, character: 11 } });
            assert.equal(attachment.text, "First line\nSecond line");
            assert.equal(attachment.displayName, "example.md:1-2");
        }
        await keys("Escape");
    });
    await t.test("Visual character and block selections retain their exact text", async () => {
        await keys("g", "g", "0", "v", "l", "l");
        await open();
        await send("Explain selection");
        assert.equal(messages.at(-1).attachments[0].text, "Fir");
        assert.deepEqual(messages.at(-1).attachments[0].selection, {
            start: { line: 0, character: 0 }, end: { line: 0, character: 3 },
        });
        await keys("Escape", "g", "g", "0", "Control+v", "j", "l");
        await open();
        await send("Explain block");
        assert.deepEqual(messages.at(-1).attachments.map(({ text, selection }) => ({ text, selection })), [
            { text: "Fi", selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } },
            { text: "Se", selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } },
        ]);
        await keys("Escape");
    });
    await t.test("cancel preserves Vim mode and failed sends retain prompt for retry", async () => {
        await keys("g", "g", "i");
        await open();
        await page.keyboard.type("Do not send");
        await keys("Escape");
        assert.equal(await page.locator(".agent-header .mode").innerText(), "NORMAL");
        assert.equal(await prompt.count(), 1);
        await keys("Escape");
        assert.equal(await prompt.count(), 0);
        assert.equal(await page.locator("#mode").innerText(), "INSERT");
        fail = true;
        await open();
        await page.keyboard.type("Retry me");
        await keys("Enter");
        await until(async () => assert.match(await page.locator(".agent-prompt [role=status]").innerText(), /Session disconnected/));
        assert.equal(await promptText(), "Retry me");
        assert.equal(await page.locator("#save-status").innerText(), "Saved to disk");
        fail = false;
        await keys("Enter");
        await until(async () => assert.equal(await prompt.count(), 0));
        assert.equal(messages.at(-1).prompt, "Retry me");
        await keys("Escape");
    });
    await t.test("pending sends are locked and file switches cannot reuse old context", async () => {
        let release;
        let started;
        const held = new Promise((resolve) => { release = resolve; });
        const sending = new Promise((resolve) => { started = resolve; });
        await page.route("**/api/agent", async (route) => {
            started();
            await held;
            await route.continue();
        }, { times: 1 });
        await open();
        await page.keyboard.type("Once only");
        const count = messages.length;
        await keys("Enter");
        await sending;
        assert.equal(await page.getByRole("button", { name: "Send to Agent", exact: true }).isDisabled(), true);
        await keys("Enter");
        release();
        await until(async () => assert.equal(await prompt.count(), 0));
        assert.equal(messages.length, count + 1);
        await open();
        await page.keyboard.type("Old file");
        await page.locator('#tree .tree-row:has-text("second.md")').dblclick();
        await until(async () => assert.equal(await page.locator("#filepath").innerText(), second));
        assert.equal(await prompt.count(), 0);
        await open();
        await send("New file");
        assert.equal(messages.at(-1).attachments[0].filePath, second);
    });
    await t.test("reviews group comments across files, persist, and send as one message", async () => {
        const count = messages.length;
        const bar = page.locator("#review");
        const reviewCount = () => page.locator("#review-count").innerText();
        const markers = () => page.locator("#editor > .cm-editor > .cm-scroller > .cm-content .cm-agent-pending").count();
        const ex = async (command) => {
            await keys(":");
            await page.keyboard.type(command);
            await keys("Enter");
        };
        assert.equal(await bar.isVisible(), false);
        await open();
        await page.keyboard.type("Rename heading");
        await keys("Control+Enter");
        await until(async () => assert.equal(await prompt.count(), 0));
        await until(async () => assert.match(await reviewCount(), /1 comment$/));
        assert.equal(await markers(), 1);
        await ex("e example.md");
        await until(async () => assert.equal(await page.locator("#filepath").innerText(), path));
        assert.equal(await markers(), 0);
        await keys("g", "g", "V", "j");
        await open();
        assert.match(await page.locator(".agent-actions").innerText(), /Send review \(1\)/);
        await page.keyboard.type("Tighten");
        await keys("Enter");
        await until(async () => assert.match(await reviewCount(), /2 comments/));
        await keys("Escape");
        assert.equal(await markers(), 2);
        assert.equal(messages.length, count);

        await page.reload();
        await page.locator(".cm-editor").waitFor();
        await until(async () => assert.match(await reviewCount(), /2 comments/));
        await until(async () => assert.equal(await markers(), 2));
        await page.locator("#review-toggle").click();
        await page.getByRole("button", { name: "Remove comment on example.md:1-2" }).click();
        await until(async () => assert.match(await reviewCount(), /1 comment$/));
        assert.equal(await markers(), 0);
        await page.locator(".review-item").first().click();
        await until(async () => assert.equal(await page.locator("#filepath").innerText(), second));
        await open();
        await page.keyboard.type("Add intro");
        await page.getByRole("button", { name: "Add to review" }).click();
        await until(async () => assert.match(await reviewCount(), /2 comments/));
        await keys("Control+Shift+Enter");
        await until(async () => assert.equal(messages.length, count + 1));
        assert.match(messages.at(-1).prompt, /2 review comments/);
        assert.match(messages.at(-1).prompt, /Rename heading[\s\S]*Add intro/);
        assert.deepEqual(messages.at(-1).attachments.map((item) => item.displayName), ["second.md:1", "second.md:1"]);
        await until(async () => assert.equal(await bar.isVisible(), false));
        assert.equal(await markers(), 0);

        await open();
        await page.keyboard.type("Discard me");
        await keys("Control+Enter");
        await until(async () => assert.equal(await bar.isVisible(), true));
        page.once("dialog", (dialog) => dialog.accept());
        await ex("AgentDiscard");
        await until(async () => assert.equal(await bar.isVisible(), false));
        await open();
        await page.keyboard.type("Via ex");
        await keys("Control+Enter");
        await until(async () => assert.equal(await bar.isVisible(), true));
        await ex("AgentSend");
        await until(async () => assert.equal(messages.length, count + 2));
        assert.match(messages.at(-1).prompt, /1 review comment\. [\s\S]*Via ex/);
        await open();
        await page.keyboard.type("Send review");
        await keys("Control+Enter");
        await until(async () => assert.equal(await bar.isVisible(), true));
        await page.getByRole("button", { name: "Send review", exact: true }).click();
        await until(async () => assert.equal(messages.length, count + 3));
        await until(async () => assert.equal(await bar.isVisible(), false));
    });
    await t.test("unsaved Unicode/CRLF text and frozen context survive a disk conflict", async () => {
        await writeFile(second, "# Caf\u00e9\r\n\r\nGr\u00fc\u00dfe\r\n");
        await page.reload();
        await page.locator(".cm-editor").waitFor();
        await until(async () => assert.match(await page.locator(".cm-content").innerText(), /Caf\u00e9/));
        await page.route("**/api/save", (route) => route.fulfill({
            status: 409, contentType: "application/json",
            body: JSON.stringify({ error: "disk_conflict", message: "The file changed on disk." }),
        }));
        await keys("i");
        await page.keyboard.type("Unsaved ");
        await until(async () => assert.equal(await page.locator("#conflict").isVisible(), true));
        await keys("Escape", "g", "g", "V", "j", "j");
        await open();
        // A background update must not silently change the context already shown in the prompt.
        await writeFile(second, "# New disk content\r\n");
        await send("Explain my draft");
        const attachment = messages.at(-1).attachments[0];
        assert.equal(attachment.text, "Unsaved # Caf\u00e9\r\n\r\nGr\u00fc\u00dfe");
        assert.deepEqual(attachment.selection, {
            start: { line: 0, character: 0 }, end: { line: 2, character: 5 },
        });
        assert.equal(await readFile(second, "utf8"), "# New disk content\r\n");
        await page.unroute("**/api/save");
        await keys("Escape");
    });
    assert.equal(await readFile(path, "utf8"), content);
    assert.deepEqual(errors, []);
});

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
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await entry.close(); });
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

    await t.test("normal/insert modes, immediate disk writes, live preview, and :w", async () => {
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

    await t.test("automatic saving survives reload and recovered drafts save automatically", async () => {
        await keys(["G", "A"]);
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
    });

    await t.test("edits during an in-flight save persist without stealing focus", async () => {
        let release;
        let started;
        const held = new Promise((resolve) => { release = resolve; });
        const saving = new Promise((resolve) => { started = resolve; });
        await page.route("**/api/save", async (route) => {
            started();
            await held;
            await route.continue();
        }, { times: 1 });
        await keys(["g", "g", "i"]);
        await page.keyboard.type("First ");
        await saving;
        await page.keyboard.type("latest ");
        await page.keyboard.press("Escape");
        await page.locator("#tree").focus();
        release();
        await until(async () => assert.match(await readFile(path, "utf8"), /^First latest /));
        await until(async () => assert.equal((await state()).dirty, false));
        assert.equal(await page.evaluate(() => document.activeElement.id), "tree");
        await page.locator(".cm-content").click();
    });

    await t.test("failed automatic writes retain the draft and keyboard save retries", async () => {
        await page.route("**/api/save", (route) => route.fulfill({
            status: 503, contentType: "application/json",
            body: JSON.stringify({ error: "write_failed", message: "Disk write failed." }),
        }));
        await keys(["g", "g", "i"]);
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
    });

    await t.test("external edits cannot overwrite a dirty draft", async () => {
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        await page.route("**/api/save", async (route) => {
            await held;
            await route.continue();
        }, { times: 1 });
        await keys(["g", "g", "i"]);
        await page.keyboard.type("Local ");
        await page.keyboard.press("Escape");
        assert.match(await page.locator(".cm-content").innerText(), /^Local /);
        await writeFile(path, "# External replacement\n");
        release();
        await until(async () => assert.equal(await page.locator("#conflict").isVisible(), true));
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
        await page.locator(".cm-content").click();
    });

    await t.test("collapsing and reopening the explorer preserves workspace geometry", async () => {
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
        await page.setViewportSize({ width: 1200, height: 820 });
        await page.locator('button[data-layout="split"]').click();
        await page.locator("#toggle-explorer").click();
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
        const headingColor = () => page.locator(".cm-line span").filter({ hasText: "Safe" }).first().evaluate((node) => getComputedStyle(node).color);
        await page.emulateMedia({ colorScheme: "light" });
        await until(async () => assert.equal(await headingColor(), "rgb(5, 80, 174)"));
        await page.emulateMedia({ colorScheme: "dark" });
        await until(async () => assert.equal(await headingColor(), "rgb(121, 192, 255)"));
        await page.emulateMedia({ colorScheme: "light" });
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

test("browser: language-data highlighting and Markdown-only preview", { timeout: 90000 }, async (t) => {
    const root = dirname(fileURLToPath(import.meta.url));
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "vim-formats-browser-")));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const files = {
        "notes.custom": "Plain text without a known language.\n",
        "script.js": "const answer = 42;\nconsole.log(answer);\n",
        "main.py": "def greet(name):\n    return 'Hello ' + name\n",
        "config.yaml": "enabled: true\ncount: 42\n",
        "data.json": '{"enabled": true, "count": 42}\n',
        "main.rs": 'fn main() { println!("Hello"); }\n',
        "Makefile": "all:\n\techo hello\n",
        "note.md": "# Hello\n\n**Markdown** preview.\n",
        "note.markdown": "# Long extension\n",
        "note.mdown": "# Alias\n",
    };
    await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(temporary, name), content)));
    await writeFile(join(temporary, "binary.bin"), Buffer.from([0, 1, 2]));
    const store = new DocumentStore(join(temporary, "artifacts"));
    const document = await store.open(join(temporary, "notes.custom"));
    const workspace = await Workspace.create({ rootPath: temporary, ignore: ["artifacts"] });
    const entry = await startServer({ store, workspace, document, root });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await entry.close(); });
    const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
    const errors = [];
    const chunkResponses = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
        if (new URL(response.url()).pathname.startsWith("/chunks/")) chunkResponses.push(response);
    });
    const open = async (name) => {
        await page.locator("#tree .tree-label").getByText(name, { exact: true }).click();
        await until(async () => assert.equal(await page.locator("#filepath").innerText(), join(temporary, name)));
    };
    const highlighted = async (name) => until(async () =>
        assert.ok(await page.locator(".cm-line > span").count() > 0, `${name} should be highlighted`));
    const editOnly = async () => {
        assert.equal(await page.locator("#layout-controls").isVisible(), false);
        assert.equal(await page.locator(".preview-pane").isVisible(), false);
        assert.equal(await page.locator("#words").isVisible(), false);
        assert.equal(await page.locator("#workspace").getAttribute("data-layout"), "edit");
        const dimensions = await page.evaluate(() => ({
            workspace: document.querySelector("#workspace").getBoundingClientRect().width,
            editor: document.querySelector(".editor-pane").getBoundingClientRect().width,
        }));
        assert.ok(Math.abs(dimensions.workspace - dimensions.editor) < 1);
    };
    await page.goto(entry.url);
    await page.locator(".cm-editor").waitFor();

    await t.test("unknown formats start as plain text without preview", async () => {
        await editOnly();
        assert.equal(await page.locator("#filetype").innerText(), "Plain text");
        assert.equal(await page.locator(".cm-line > span").count(), 0);
        assert.equal(await page.locator("#preview").innerText(), "");
    });

    await t.test("late language loads cannot replace the next document's language", async () => {
        let release;
        let started;
        let delayedResponse;
        let yamlTokens;
        const held = new Promise((resolve) => { release = resolve; });
        const loading = new Promise((resolve) => { started = resolve; });
        await page.route("**/chunks/*.js", async (route) => {
            delayedResponse = route.request().response();
            started();
            await held;
            await route.continue();
        }, { times: 1 });
        try {
            await open("script.js");
            await loading;
            await open("config.yaml");
            await highlighted("YAML");
            yamlTokens = await page.locator(".cm-line > span").evaluateAll((spans) =>
                spans.map((span) => [span.textContent, span.className]));
        } finally {
            release();
        }
        await (await delayedResponse).finished();
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await until(async () => assert.equal(await page.locator("#filetype").innerText(), "YAML"));
        assert.deepEqual(await page.locator(".cm-line > span").evaluateAll((spans) =>
            spans.map((span) => [span.textContent, span.className])), yamlTokens);
        await open("script.js");
        await highlighted("JavaScript");
        assert.equal(await page.locator("#filetype").innerText(), "JavaScript");
        await editOnly();
    });

    await t.test("multiple languages load locally and retain Vim automatic saving", async () => {
        for (const [name, language] of [
            ["main.py", "Python"], ["config.yaml", "YAML"],
            ["data.json", "JSON"], ["main.rs", "Rust"],
        ]) {
            await open(name);
            await highlighted(language);
            assert.equal(await page.locator("#filetype").innerText(), language);
            await editOnly();
        }
        await open("Makefile");
        assert.equal(await page.locator("#filetype").innerText(), "Plain text");
        await open("main.py");
        await page.locator(".cm-content").click();
        await page.keyboard.press("Escape");
        for (const key of ["g", "g", "0", "i"]) await page.keyboard.press(key);
        await page.keyboard.type("# edited\n");
        await page.keyboard.press("Escape");
        await until(async () => assert.equal(await readFile(join(temporary, "main.py"), "utf8"), `# edited\n${files["main.py"]}`));
        await page.reload();
        await page.locator(".cm-editor").waitFor();
        await highlighted("Python");
        await editOnly();
        assert.match(await page.locator(".cm-content").innerText(), /^# edited/);
        assert.equal(await page.locator("#filetype").innerText(), "Python");
    });

    await t.test("Markdown aliases retain all layouts and restore the selected setting", async () => {
        for (const [index, name] of ["note.md", "note.markdown", "note.mdown"].entries()) {
            await open(name);
            assert.equal(await page.locator("#filetype").innerText(), "Markdown");
            assert.equal(await page.locator("#layout-controls").isVisible(), true);
            assert.equal(await page.locator("#words").isVisible(), true);
            assert.equal(await page.locator("#preview h1").count(), 1);
            const layout = ["preview", "edit", "split"][index];
            await page.locator(`button[data-layout="${layout}"]`).click();
            await open("data.json");
            await editOnly();
            assert.equal(await page.locator("#preview").innerText(), "");
            await open(name);
            assert.equal(await page.locator("#workspace").getAttribute("data-layout"), layout);
            assert.equal(await page.locator(`button[data-layout="${layout}"]`).getAttribute("aria-pressed"), "true");
            assert.equal(await page.locator(".preview-pane").isVisible(), layout !== "edit");
            assert.equal(await page.locator(".editor-pane").isVisible(), layout !== "preview");
        }
    });

    await t.test("plain text clears highlighting; binary files leave the current document intact", async () => {
        await open("notes.custom");
        assert.equal(await page.locator(".cm-line > span").count(), 0);
        await page.locator("#tree .tree-label").getByText("binary.bin", { exact: true }).click();
        await until(async () => assert.match(await page.locator("#notice").innerText(), /only supports text files/));
        assert.equal(await page.locator("#filepath").innerText(), join(temporary, "notes.custom"));
        for (const width of [700, 480]) {
            await page.setViewportSize({ width, height: 720 });
            await editOnly();
            assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
        }
    });

    assert.ok(chunkResponses.length > 0);
    assert.ok(chunkResponses.every((response) => response.status() === 200));
    assert.ok(chunkResponses.every((response) => response.headers()["content-type"].startsWith("text/javascript")));
    assert.deepEqual(errors, []);
});
