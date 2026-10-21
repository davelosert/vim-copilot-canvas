import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { onTestFinished, test } from "vitest";
import { documentFixture, startEditorServer, Workspace } from "../helpers/fixtures.mjs";
import { until } from "../helpers/browser.mjs";

async function open(engine, content) {
    const fixture = await documentFixture({ content });
    const workspace = await Workspace.create({ rootPath: fixture.root });
    const entry = await startEditorServer({ store: fixture.store, document: fixture.document, workspace });
    const browser = await engine.launch({ headless: true });
    onTestFinished(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    const renders = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/render") renders.push(request); });
    await page.setContent(`<iframe style="width: 1100px; height: 760px; border: 0" src="${entry.url}"></iframe>`);
    return { fixture, page, frame: page.frameLocator("iframe"), errors, renders };
}

test.each([["Chromium", chromium], ["WebKit", webkit]])(
    "%s renders on the server in an iframe and suspends rendering in Edit-only mode",
    async (_name, engine) => {
        const { fixture, page, frame, errors, renders } = await open(engine, "# Title\n\nFirst paragraph.\n\n## Retained\n\nLast paragraph.\n");
        await frame.locator("#preview h1").waitFor();
        assert.equal(await frame.locator("#preview h1").innerText(), "Title");
        await frame.locator("#preview").evaluate((element) => { element.ownerDocument.defaultView.retained = element.querySelector("h2"); });
        await frame.locator('button[data-layout="edit"]').click();
        const before = renders.length;
        await page.keyboard.press("i");
        await page.keyboard.type("Hidden ");
        await page.keyboard.press("Escape");
        await until(async () => assert.match((await fixture.store.snapshot(fixture.document)).content, /^Hidden /));
        await page.waitForTimeout(200);
        assert.equal(renders.length, before);
        assert.equal(await frame.locator("#preview h1").innerText(), "Title");
        await frame.locator('button[data-layout="split"]').click();
        await until(async () => assert.match(await frame.locator("#preview").innerText(), /^Hidden # Title/));
        assert.equal(await frame.locator("#preview").evaluate((element) => element.querySelector("h2") === element.ownerDocument.defaultView.retained), true);
        assert.equal(renders.length, before + 1);
        assert.deepEqual(errors, []);
    },
);

test.each([["Chromium", chromium], ["WebKit", webkit]])("%s renders and updates a document close to the 2 MiB limit", async (_name, engine) => {
    const section = (index) => `## Section ${index}\n\n${"Some **bold** and `code` text with a [link](https://example.com). ".repeat(13)}\n\n- item\n- item\n\n`;
    const content = `# Large\n\n${Array.from({ length: 2200 }, (_, index) => section(index)).join("")}`;
    assert.ok(content.length > 1_900_000 && content.length < 2 * 1024 * 1024);
    const { page, frame, errors } = await open(engine, content);
    await until(async () => assert.equal(await frame.locator("#preview h2").count(), 2200), 20000);
    await frame.locator(".cm-content").click();
    await page.keyboard.type("GA");
    await page.keyboard.type("\n\n## Appended");
    await page.keyboard.press("Escape");
    await until(async () => assert.equal(await frame.locator("#preview h2").last().innerText(), "Appended"), 20000);
    assert.deepEqual(errors, []);
}, 60000);
