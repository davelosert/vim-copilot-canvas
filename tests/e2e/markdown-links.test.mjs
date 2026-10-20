import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { onTestFinished, test } from "vitest";
import { documentFixture, startEditorServer, Workspace } from "../helpers/fixtures.mjs";

test.each([["Chromium", chromium], ["WebKit", webkit]])(
    "%s keeps the link cursor stable during real pointer movement in an iframe",
    async (_name, engine) => {
        const fixture = await documentFixture({ content: "Start [label](https://example.com/path) end\n" });
        const workspace = await Workspace.create({ rootPath: fixture.root });
        const entry = await startEditorServer({ store: fixture.store, document: fixture.document, workspace });
        const browser = await engine.launch({ headless: true });
        onTestFinished(() => browser.close());
        const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(`<iframe style="width: 1100px; height: 760px; border: 0" src="${entry.url}"></iframe>`);
        const frame = page.frameLocator("iframe");
        await frame.locator(".cm-content").waitFor();
        const content = frame.locator(".cm-content");
        const modifier = await content.evaluate((element) =>
            /mac|iphone|ipad/i.test(element.ownerDocument.defaultView.navigator.platform) ? "Meta" : "Control");
        const line = frame.locator(".cm-line").first();
        const points = await line.evaluate((element) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            const result = [];
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (!node.textContent.includes("example.com")) continue;
                for (let offset = 1; offset < node.textContent.length - 1; offset++) {
                    const range = document.createRange();
                    range.setStart(node, offset);
                    range.setEnd(node, offset + 1);
                    const rect = range.getBoundingClientRect();
                    result.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
                }
            }
            return result;
        });
        assert.ok(points.length > 10);
        const iframe = await page.locator("iframe").boundingBox();
        const move = (point) => page.mouse.move(iframe.x + point.x, iframe.y + point.y);
        const start = await line.boundingBox();
        const outside = { x: start.x + 2, y: start.y + start.height / 2 };
        const defaultCursor = await content.evaluate((element) => getComputedStyle(element).cursor);
        await content.focus();
        await page.mouse.move(outside.x, outside.y);
        await page.keyboard.down(modifier);
        for (const point of points) {
            await move(point);
            assert.equal(await content.evaluate((element) => getComputedStyle(element).cursor), "pointer");
        }
        // Sample across animation frames too, rather than only just after each event.
        const cursors = await content.evaluate(async (element) => {
            const samples = [];
            for (let index = 0; index < 10; index++) {
                await new Promise(requestAnimationFrame);
                samples.push(getComputedStyle(element).cursor);
            }
            return samples;
        });
        assert.ok(cursors.every((cursor) => cursor === "pointer"));
        await page.mouse.move(outside.x, outside.y);
        assert.equal(await content.evaluate((element) => getComputedStyle(element).cursor), defaultCursor);
        await move(points[0]);
        assert.equal(await content.evaluate((element) => getComputedStyle(element).cursor), "pointer");
        await page.keyboard.up(modifier);
        assert.equal(await content.evaluate((element) => getComputedStyle(element).cursor), defaultCursor);
        assert.deepEqual(errors, []);
    },
);
