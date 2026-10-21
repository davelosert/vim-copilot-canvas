import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished, test } from "vitest";
import { createMarkdownService } from "../../src/backend/markdown-service.mjs";
import { tempDir, writeFiles } from "../helpers/fixtures.mjs";

const script = fileURLToPath(new URL("../../assets/server/markdown-worker.mjs", import.meta.url));
const service = (path = script) => {
    const markdown = createMarkdownService({ script: path });
    onTestFinished(() => markdown.close());
    return markdown;
};

test("renders concurrent requests in the bundled worker and matches each response to its request", async () => {
    const markdown = service();
    const results = await Promise.all(["# One", "Two words", "- three"].map((source) => markdown.render(source)));
    assert.deepEqual(results, [
        { html: '<h1 id="user-content-one">One</h1>\n', count: 2 },
        { html: "<p>Two words</p>\n", count: 2 },
        { html: "<ul>\n<li>three</li>\n</ul>\n", count: 2 },
    ]);
    await assert.rejects(markdown.render(undefined), { code: "invalid_input", status: 400 });
});

test("rejects pending requests when the worker crashes and restarts on the next request", async () => {
    const root = await tempDir("vim-markdown-worker-");
    await writeFiles(root, {
        "crash.mjs": `import { parentPort } from "node:worker_threads";
let calls = 0;
parentPort.on("message", ({ id, source }) => {
    if (source === "crash") throw new Error("boom");
    parentPort.postMessage(source === "fail" ? { id, error: "bad input" } : { id, html: source, count: ++calls });
});`,
    });
    const markdown = service(join(root, "crash.mjs"));
    await assert.rejects(markdown.render("fail"), { code: "render_failed", message: "Markdown rendering failed: bad input" });
    assert.deepEqual(await markdown.render("ok"), { html: "ok", count: 1 });
    const crashed = markdown.render("crash");
    const queued = markdown.render("queued behind the crash");
    await assert.rejects(crashed, { code: "render_failed", message: /Markdown renderer crashed: boom/ });
    await assert.rejects(queued, { code: "render_failed" });
    assert.deepEqual(await markdown.render("again"), { html: "again", count: 1 });
});
