import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { DocumentStore, Workspace, startEditorServer, tempDir } from "../helpers/fixtures.mjs";
import { keyPresser, openEditorPage, until, useBrowser } from "../helpers/browser.mjs";

const browser = useBrowser();
const content = "First line\nSecond line\nThird line\n";

/**
 * Fresh workspace (example.md, second.md), production server with a stub session, and page.
 * `initial` selects the document the panel starts on.
 */
async function agentPage({ initial = "example.md" } = {}) {
    const temporary = await tempDir("vim-markdown-agent-");
    const path = join(temporary, "example.md");
    const second = join(temporary, "second.md");
    await writeFile(path, content);
    await writeFile(second, "# Second\n");
    const store = new DocumentStore(join(temporary, "artifacts"));
    const document = await store.open(join(temporary, initial));
    const workspace = await Workspace.create({ rootPath: temporary, ignore: ["artifacts"] });
    const session = { messages: [], fail: false };
    const entry = await startEditorServer({
        store, workspace, document,
        sendMessage: async (message) => {
            if (session.fail) throw new Error("Session disconnected");
            session.messages.push(message);
            return `message-${session.messages.length}`;
        },
    });
    const { page, errors } = await openEditorPage(browser(), entry);
    const prompt = page.getByRole("textbox", { name: "Agent prompt" });
    const keys = keyPresser(page);
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
    const promptText = async () => (await prompt.locator(".cm-line").allInnerTexts()).join("\n");
    /** Final checks retained from the original combined scenario. */
    const finish = async () => {
        assert.equal(await readFile(path, "utf8"), content);
        assert.deepEqual(errors, []);
    };
    return { temporary, path, second, store, session, messages: session.messages, page, prompt, keys, open, send, promptText, finish };
}

test("agent prompt: cursor line, inline placement, newline, no duplicates and focus restoration", async () => {
    const { path, messages, page, prompt, keys, open, promptText, finish } = await agentPage();
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
    await finish();
});

test("agent prompt: forward and backward Visual line selections preserve CodeMirror's range", async () => {
    const { messages, keys, open, send, finish } = await agentPage();
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
    await finish();
});

test("agent prompt: Visual character and block selections retain their exact text", async () => {
    const { messages, keys, open, send, finish } = await agentPage();
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
    await finish();
});

test("agent prompt: cancel preserves Vim mode and failed sends retain prompt for retry", async () => {
    const { session, messages, page, prompt, keys, open, promptText, finish } = await agentPage();
    await keys("g", "g", "i");
    await open();
    await page.keyboard.type("Do not send");
    await keys("Escape");
    assert.equal(await page.locator(".agent-header .mode").innerText(), "NORMAL");
    assert.equal(await prompt.count(), 1);
    await keys("Escape");
    assert.equal(await prompt.count(), 0);
    assert.equal(await page.locator("#mode").innerText(), "INSERT");
    session.fail = true;
    await open();
    await page.keyboard.type("Retry me");
    await keys("Enter");
    await until(async () => assert.match(await page.locator(".agent-prompt [role=status]").innerText(), /Session disconnected/));
    assert.equal(await promptText(), "Retry me");
    assert.equal(await page.locator("#save-status").innerText(), "Saved to disk");
    session.fail = false;
    await keys("Enter");
    await until(async () => assert.equal(await prompt.count(), 0));
    assert.equal(messages.at(-1).prompt, "Retry me");
    await keys("Escape");
    await finish();
});

test("agent prompt: pending sends are locked and file switches cannot reuse old context", async () => {
    const { second, messages, page, prompt, keys, open, send, finish } = await agentPage();
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
    await finish();
});

test("reviews group comments across files, persist across reload, and send as one message", async () => {
    // Starts on second.md, as the original sequence did after switching files.
    const { path, second, messages, page, prompt, keys, open, finish } = await agentPage({ initial: "second.md" });
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
    await finish();
});

test("reviews can be discarded or sent with :AgentDiscard, :AgentSend and the review button", async () => {
    const { messages, page, keys, open, finish } = await agentPage({ initial: "second.md" });
    const count = messages.length;
    const bar = page.locator("#review");
    const ex = async (command) => {
        await keys(":");
        await page.keyboard.type(command);
        await keys("Enter");
    };
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
    await until(async () => assert.equal(messages.length, count + 1));
    assert.match(messages.at(-1).prompt, /1 review comment\. [\s\S]*Via ex/);
    await open();
    await page.keyboard.type("Send review");
    await keys("Control+Enter");
    await until(async () => assert.equal(await bar.isVisible(), true));
    await page.getByRole("button", { name: "Send review", exact: true }).click();
    await until(async () => assert.equal(messages.length, count + 2));
    await until(async () => assert.equal(await bar.isVisible(), false));
    await finish();
});

test("agent prompt: unsaved Unicode/CRLF text and frozen context survive a disk conflict", async () => {
    const { second, messages, page, keys, open, send, finish } = await agentPage({ initial: "second.md" });
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
    await finish();
});
