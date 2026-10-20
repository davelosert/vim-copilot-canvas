import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { documentFixture, repoRoot, Workspace, writeFiles, startEditorServer } from "../helpers/fixtures.mjs";
import { openEditorPage, until, useBrowser } from "../helpers/browser.mjs";

const browser = useBrowser();

test("README HTML logo and Markdown images render without fetching remote resources", async () => {
    const logo = await readFile(join(repoRoot, "public/logo.svg"), "utf8");
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    const { root, store, document } = await documentFixture({
        name: "docs/README.md",
        content: `${readme.replace('src="public/logo.svg"', 'src="../public/logo.svg"')}\n\n![Markdown logo](../public/logo.svg)\n\n![Remote](https://example.com/tracker.png)\n\n![Missing](missing.png)`,
    });
    await writeFiles(root, { "public/logo.svg": logo });
    const workspace = await Workspace.create({ rootPath: root });
    const entry = await startEditorServer({ store, workspace, document });
    const { page, errors } = await openEditorPage(browser(), null);
    const externalRequests = [];
    page.on("request", (request) => {
        if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(entry.url).origin) externalRequests.push(request.url());
    });
    await page.goto(entry.url);
    const images = page.locator("#preview img");
    await until(async () => {
        assert.equal(await images.count(), 2);
        assert.deepEqual(await images.evaluateAll((nodes) => nodes.map((node) => node.complete && node.naturalWidth > 0)), [true, true]);
        assert.equal(await page.locator("#preview .image-error").count(), 2);
    });
    assert.equal(await images.first().getAttribute("width"), "80");
    assert.equal(await images.first().getAttribute("height"), "80");
    assert.equal(await images.first().evaluate((node) => node.getBoundingClientRect().width), 80);
    assert.match(await page.locator("#preview").innerText(), /Only local workspace images are supported/);
    assert.match(await page.locator("#preview").innerText(), /No such file/);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
});
