import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { onTestFinished, test } from "vitest";
import { DocumentStore, Workspace, startEditorServer, tempDir } from "../helpers/fixtures.mjs";
import { keyPresser, openEditorPage, until, useBrowser } from "../helpers/browser.mjs";
import { createAgentHistory } from "../../src/backend/agent-history.mjs";

const browser = useBrowser();
const content = "First line\nSecond line\nThird line\n";

/**
 * Fresh workspace (example.md, second.md), production server with a stub session, and page.
 * `initial` selects the document the panel starts on.
 */
async function agentPage({ initial = "example.md", browserInstance = browser(), platform, embedded = false } = {}) {
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
    const { page, errors } = await openEditorPage(browserInstance, null);
    if (platform) await page.addInitScript((value) => {
        Object.defineProperty(navigator, "platform", { get: () => value });
        Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
    }, platform);
    if (embedded) await page.setContent(`<iframe title="Canvas" style="width: 1100px; height: 760px; border: 0" src="${entry.url}"></iframe>`);
    else await page.goto(entry.url);
    const surface = embedded ? page.frameLocator("iframe") : page;
    await surface.locator(".cm-editor").waitFor();
    const prompt = surface.getByRole("textbox", { name: "Agent prompt" });
    const keys = keyPresser(page);
    const open = async () => {
        await page.keyboard.press("Control+i");
        await prompt.waitFor();
        assert.equal(await prompt.evaluate((node) => node === document.activeElement), true);
        assert.equal(await surface.locator(".agent-header .mode").innerText(), "INSERT");
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
    return { temporary, path, second, store, session, messages: session.messages, page, surface, prompt, keys, open, send, promptText, finish, errors };
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

test("Copilot edits are visually distinct from sent requests, whose prompts stay in the main editor", async () => {
    const { path, store, page, open, send, errors } = await agentPage();
    await open();
    await send("Rewrite the first line");
    const tracker = createAgentHistory({ store, sessionId: "test-session" });
    const emit = (type, data) => tracker.handle({ type, data, timestamp: new Date().toISOString() });
    await emit("user.message", { messageId: "message-1", turnId: "turn-1" });
    await emit("tool.execution_start", { toolCallId: "tool-1", toolName: "apply_patch", turnId: "turn-1" });
    await writeFile(path, content.replace("First line", "Rewritten first line"));
    await emit("tool.execution_complete", {
        toolCallId: "tool-1", turnId: "turn-1", success: true, fileEdits: [{ path, kind: "edit" }],
    });
    await page.locator("#history-tab").click();
    await page.getByRole("button", { name: /Copilot file write/ }).click();
    await page.getByRole("textbox", { name: "Inline history diff" }).waitFor();
    await page.locator("#history-review-diff .history-sent-prompt").waitFor();
    assert.match(await page.locator("#history-review-diff .history-sent-prompt").innerText(), /Rewrite the first line/);
    assert.equal(await page.locator("#history-editor").isVisible(), true);
    assert.equal(await page.locator("#history-detail .cm-editor").count(), 0);
    assert.match(await page.locator("#history-detail").innerText(), /snapshot may also include concurrent edits/);
    assert.equal(await page.locator("#history-list .history-copilot").count(), 1);
    assert.equal(await page.locator("#history-list .history-request").count(), 1);
    assert.match(await page.locator("#history-list .history-copilot .history-event-kind").innerText(), /EDIT/);
    assert.match(await page.locator("#history-list .history-request .history-event-kind").innerText(), /REQUEST/);
    assert.doesNotMatch(await page.locator("#history-panel").textContent(), /Rewrite the first line|Same agent turn/);
    await page.getByRole("button", { name: /Sent to Copilot/ }).click();
    await page.getByRole("textbox", { name: "Historical request source" }).waitFor();
    assert.match(await page.locator(".history-sent-prompt").innerText(), /Rewrite the first line/);
    assert.match(await page.locator("#history-review-diff .cm-line").first().innerText(), /First line/);
    assert.doesNotMatch(await page.locator("#history-panel").textContent(), /Rewrite the first line|Same agent turn/);
    await page.getByRole("button", { name: "Return to editing" }).click();
    await writeFile(path, "Unrelated external edit\n");
    await until(async () => assert.match(await page.locator("#editor .cm-content").innerText(), /Unrelated external edit/));
    await page.getByRole("button", { name: /External edit/ }).click();
    assert.doesNotMatch(await page.locator("#history-panel").textContent(), /Same agent turn/);
    assert.deepEqual(errors, []);
});

test("individual requests and multi-file batches persist in the file history after sending and reloading", async () => {
    const { path, second, messages, page, open, send, keys, finish } = await agentPage();
    await open(); await send("Explain first line");
    await open();
    await page.keyboard.type("Improve first file");
    await page.keyboard.press("Control+Enter");
    await until(async () => assert.equal(await page.locator(".agent-prompt").count(), 0));
    await page.keyboard.type(":e second.md");
    await page.keyboard.press("Enter");
    await until(async () => assert.match(await page.locator("#filepath").innerText(), /second.md$/));
    await open();
    await page.keyboard.type("Improve second file");
    await page.keyboard.press("Control+Enter");
    await until(async () => assert.equal(await page.locator(".agent-prompt").count(), 0));
    await page.locator("#review-send").click();
    await until(async () => assert.equal(messages.length, 2));
    await until(async () => assert.equal(await page.locator("#review").isVisible(), false));
    await page.locator("#history-tab").click();
    await page.getByRole("button", { name: /Sent batch/ }).click();
    await until(async () => assert.equal(await page.locator(".history-sent-prompt").count(), 2));
    assert.match(await page.locator(".history-sent-prompt").nth(0).innerText(), /Improve first file/);
    assert.match(await page.locator(".history-sent-prompt").nth(1).innerText(), /Improve second file/);
    assert.doesNotMatch(await page.locator("#history-panel").textContent(), /Improve second file|Improve first file/);
    assert.equal(await page.locator("#history-review-diff select").count(), 0);
    assert.equal(await page.locator("#filepath").innerText(), second);
    await page.reload();
    await page.locator(".cm-editor").waitFor();
    await page.locator("#history-tab").click();
    await page.getByRole("button", { name: /Sent batch/ }).waitFor();
    await keys("Escape");
    await page.locator("#editor .cm-content").click();
    await page.keyboard.type(":e example.md");
    await page.keyboard.press("Enter");
    await until(async () => assert.match(await page.locator("#filepath").innerText(), /example.md$/));
    await page.getByRole("button", { name: /Sent to Copilot/ }).click();
    await until(async () => assert.match(await page.locator(".history-sent-prompt").innerText(), /Explain first line/));
    assert.match(await page.locator("#history-review-diff .cm-line").first().innerText(), /First line/);
    assert.equal(messages.length, 2);
    await finish();
});

test.each([
    ["Chromium", "MacIntel", "Meta", chromium],
    ["Chromium", "Linux x86_64", "Control", chromium],
    ["Chromium", "Win32", "Control", chromium],
    ["WebKit", "MacIntel", "Meta", webkit],
])("%s on %s: Select All replaces only the Agent prompt", async (_name, platform, modifier, engine) => {
    const instance = await engine.launch({ headless: true });
    onTestFinished(() => instance.close());
    const { page, surface, prompt, messages, finish } = await agentPage({ browserInstance: instance, platform, embedded: true });
    for (const vimMode of [true, false]) {
        if (!vimMode) {
            await surface.locator("#settings-button").click();
            await surface.locator("#agent-vim-mode").uncheck();
            await surface.locator("#save-settings").click();
            await until(async () => assert.equal(await surface.locator("#settings").isVisible(), false));
        }
        await surface.getByRole("textbox", { name: "Text editor" }).focus();
        await page.keyboard.press("Control+i");
        await prompt.waitFor();
        await page.keyboard.type("First prompt line");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("Second prompt line");
        await page.keyboard.press(`${modifier}+a`);
        assert.deepEqual(await surface.locator(".agent-prompt").evaluate((form) => {
            const inner = form.inner;
            const selection = document.getSelection();
            return {
                text: inner.state.sliceDoc(inner.state.selection.main.from, inner.state.selection.main.to),
                contained: inner.contentDOM.contains(selection.anchorNode) && inner.contentDOM.contains(selection.focusNode),
                focused: document.activeElement === inner.contentDOM,
            };
        }), { text: "First prompt line\nSecond prompt line", contained: true, focused: true });
        await page.keyboard.type("Replacement prompt");
        await page.keyboard.press("Enter");
        await until(async () => assert.equal(await prompt.count(), 0,
            await surface.locator(".agent-status").allTextContents()));
        assert.equal(messages.at(-1).prompt, "Replacement prompt");
    }
    await finish();
});

test("Primer prompt and review controls follow live themes without changing the host colour mode", async () => {
    const { page, open, prompt, keys, finish } = await agentPage();
    await page.evaluate(() => { document.documentElement.dataset.colorMode = "light"; });
    await open();
    await page.keyboard.type("Review with Primer");
    const scope = page.locator(".agent-prompt");
    const primary = scope.locator(".btn-primary");
    for (const mode of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.colorMode = value; }, mode);
        await until(async () => assert.equal(await scope.getAttribute("data-color-mode"), mode));
        assert.equal(await page.locator("#review").getAttribute("data-color-mode"), mode);
        const contrast = await primary.evaluate((node) => {
            const luminance = (color) => {
                const channels = color.match(/[\d.]+/g).slice(0, 3).map((value) => {
                    const channel = Number(value) / 255;
                    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                });
                return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
            };
            const style = getComputedStyle(node);
            const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
            return (values[0] + 0.05) / (values[1] + 0.05);
        });
        assert.ok(contrast >= 4.5, `${mode} primary contrast: ${contrast}`);
        assert.equal(await scope.locator(".agent-input .cm-editor").evaluate((node) =>
            getComputedStyle(node).backgroundColor === getComputedStyle(document.querySelector("#editor > .cm-editor")).backgroundColor), true);
    }
    await page.evaluate(() => { document.documentElement.dataset.colorMode = "light"; });
    await page.locator("#settings-button").click();
    await page.locator("#editor-theme").selectOption("dracula");
    await page.locator("#save-settings").click();
    await until(async () => assert.equal(await page.locator("#settings-status").innerText(), "Settings saved."));
    assert.equal(await page.locator("#settings").isVisible(), false);
    await until(async () => assert.equal(await scope.getAttribute("data-color-mode"), "dark"));
    assert.equal(await page.locator("html").getAttribute("data-color-mode"), "light");
    await until(async () => assert.equal(await scope.getByRole("button", { name: "Add to batch", exact: true }).evaluate((node) =>
        getComputedStyle(node).backgroundColor === getComputedStyle(document.querySelector(".toolbar")).backgroundColor), true));
    assert.equal(await scope.locator(".agent-input .cm-editor").evaluate((node) =>
        getComputedStyle(node).backgroundColor === getComputedStyle(document.querySelector("#editor > .cm-editor")).backgroundColor), true);
    assert.equal(await prompt.innerText(), "Review with Primer");
    assert.equal(await scope.locator(".mode").innerText(), "INSERT");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#toggle-explorer").click();
    await prompt.click();
    assert.equal(await scope.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth && node.scrollWidth <= node.clientWidth;
    }), true);
    await keys("Control+Enter");
    await until(async () => assert.equal(await prompt.count(), 0));
    assert.equal(await page.locator("#review-send.btn-primary").isVisible(), true);
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
    assert.equal(await page.locator("#save-status").isVisible(), false);
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
    const { path, second, messages, page, prompt, keys, open, promptText, finish } = await agentPage({ initial: "second.md" });
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
    await until(async () => assert.match(await reviewCount(), /1 pending request$/));
    assert.equal(await markers(), 1);
    await ex("e example.md");
    await until(async () => assert.equal(await page.locator("#filepath").innerText(), path));
    assert.equal(await markers(), 0);
    await keys("g", "g", "V", "j");
    await open();
    assert.match(await page.locator(".agent-actions").innerText(), /Send batch \(1\)/);
    await page.keyboard.type("Tighten");
    await keys("Control+Enter");
    await until(async () => assert.match(await reviewCount(), /2 pending requests/));
    await keys("Escape");
    assert.equal(await markers(), 2);
    assert.equal(messages.length, count);

    await page.reload();
    await page.locator(".cm-editor").waitFor();
    await until(async () => assert.match(await reviewCount(), /2 pending requests/));
    await until(async () => assert.equal(await markers(), 2));
    await page.locator("#review-toggle").click();
    await page.getByRole("button", { name: "Remove comment on example.md:1-2" }).click();
    await until(async () => assert.match(await reviewCount(), /1 pending request$/));
    assert.equal(await markers(), 0);
    await page.locator(".review-item").first().click();
    await until(async () => assert.equal(await page.locator("#filepath").innerText(), second));
    await until(async () => assert.equal(await promptText(), "Rename heading"));
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await open();
    await page.keyboard.type("Add intro");
    await page.getByRole("button", { name: "Add to batch" }).click();
    await until(async () => assert.match(await reviewCount(), /2 pending requests/));
    await keys("Control+Shift+Enter");
    await until(async () => assert.equal(messages.length, count + 1));
    assert.match(messages.at(-1).prompt, /2 batched requests/);
    assert.match(messages.at(-1).prompt, /Rename heading[\s\S]*Add intro/);
    assert.deepEqual(messages.at(-1).attachments.map((item) => item.displayName), ["second.md:1", "second.md:1"]);
    await until(async () => assert.equal(await bar.isVisible(), false));
    assert.equal(await markers(), 0);
    await finish();
});

test("review icons reopen comments for persistent edits and deletion without changing attachments", async () => {
    const { path, messages, page, prompt, keys, open, promptText, finish } = await agentPage();
    await keys("j");
    await open();
    await page.keyboard.type("Original comment");
    await keys("Control+Enter");
    await until(async () => assert.equal(await page.locator(".review-marker").count(), 1));
    const icon = page.locator(".review-marker");
    assert.equal(await icon.getAttribute("aria-label"), "Edit comment on example.md:2: Original comment");
    await icon.waitFor();
    await icon.click();
    assert.equal(await promptText(), "Original comment");
    await icon.click();
    assert.equal(await prompt.count(), 0);
    await icon.click();
    assert.equal(await promptText(), "Original comment");
    await keys("Escape", "c", "c");
    await page.keyboard.type("Changed comment");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await until(async () => assert.equal(await prompt.count(), 0));
    await page.reload();
    const updated = page.locator(".review-marker");
    await updated.waitFor();
    assert.equal(await updated.getAttribute("aria-label"), "Edit comment on example.md:2: Changed comment");
    await updated.click();
    assert.equal(await promptText(), "Changed comment");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator("#review-send").click();
    await until(async () => assert.equal(messages.length, 1));
    assert.match(messages[0].prompt, /Changed comment/);
    assert.deepEqual(messages[0].attachments, [{
        type: "selection", filePath: path, displayName: "example.md:2",
        selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 11 } },
        text: "Second line",
    }]);
    await until(async () => assert.equal(await page.locator(".review-marker").count(), 0));
    await page.locator("#editor > .cm-editor > .cm-scroller > .cm-content").focus();
    await open();
    await page.keyboard.type("Delete me");
    await keys("Control+Enter");
    await page.locator(".review-marker").click();
    await page.getByRole("button", { name: "Delete comment", exact: true }).click();
    await until(async () => assert.equal(await page.locator(".review-marker").count(), 0));
    assert.equal(await prompt.count(), 0);
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
    assert.match(messages.at(-1).prompt, /1 batched request\. [\s\S]*Via ex/);
    await open();
    await page.keyboard.type("Send review");
    await keys("Control+Enter");
    await until(async () => assert.equal(await bar.isVisible(), true));
    await page.getByRole("button", { name: "Send batch", exact: true }).click();
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
