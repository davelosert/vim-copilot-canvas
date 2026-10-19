import { chromium } from "playwright";
import { afterAll, beforeAll, onTestFinished } from "vitest";

/** Retry an assertion until it passes or the timeout expires (production polling takes 2 seconds). */
export async function until(assertion, timeout = 7000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        try { await assertion(); return; }
        catch (error) { last = error; }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw last;
}

/**
 * Launch one headless Chromium for the current test file. Returns a getter because the browser is
 * created in beforeAll.
 */
export function useBrowser() {
    let browser;
    beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
    afterAll(async () => { await browser?.close(); });
    return () => browser;
}

/**
 * Open the production page of an editor server in a fresh browser context (isolated storage),
 * closed when the current test finishes. `errors` collects uncaught page errors.
 */
export async function openEditorPage(browser, entry, { viewport = { width: 1200, height: 820 }, waitForEditor = true } = {}) {
    const context = await browser.newContext({ viewport });
    onTestFinished(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (entry) {
        await page.goto(entry.url);
        if (waitForEditor) await page.locator(".cm-editor").waitFor();
    }
    return { context, page, errors };
}

/** Press keys sequentially. */
export function keyPresser(page) {
    return async (...sequence) => {
        for (const key of sequence.flat()) await page.keyboard.press(key);
    };
}

/** Run a Vim Ex command. */
export function exCommand(page) {
    return async (value) => {
        await page.keyboard.press(":");
        await page.keyboard.type(value);
        await page.keyboard.press("Enter");
    };
}
