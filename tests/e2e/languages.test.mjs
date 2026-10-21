import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { DocumentStore, Workspace, startEditorServer, tempDir, writeFiles } from "../helpers/fixtures.mjs";
import { openEditorPage, until, useBrowser } from "../helpers/browser.mjs";

const browser = useBrowser();
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

/** Fresh multi-format workspace starting on notes.custom; records production chunk responses. */
async function languagePage() {
    const temporary = await tempDir("vim-formats-browser-");
    await writeFiles(temporary, { ...files, "binary.bin": Buffer.from([0, 1, 2]) });
    const store = new DocumentStore(join(temporary, "artifacts"));
    const document = await store.open(join(temporary, "notes.custom"));
    const workspace = await Workspace.create({ rootPath: temporary, ignore: ["artifacts"] });
    const entry = await startEditorServer({ store, workspace, document });
    const { page, errors } = await openEditorPage(browser(), entry, { waitForEditor: false });
    const chunkResponses = [];
    page.on("response", (response) => {
        if (new URL(response.url()).pathname.startsWith("/chunks/")) chunkResponses.push(response);
    });
    await page.goto(entry.url);
    await page.locator(".cm-editor").waitFor();
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
    /** Chunks are served locally with JavaScript MIME type; no page errors. */
    const finish = async ({ chunksLoaded = false } = {}) => {
        if (chunksLoaded) assert.ok(chunkResponses.length > 0);
        assert.ok(chunkResponses.every((response) => response.status() === 200));
        assert.ok(chunkResponses.every((response) => response.headers()["content-type"].startsWith("text/javascript")));
        assert.deepEqual(errors, []);
    };
    return { temporary, page, open, highlighted, editOnly, finish };
}

test("unknown formats start as plain text without preview", async () => {
    const { page, editOnly, finish } = await languagePage();
    await editOnly();
    assert.equal(await page.locator("#filetype").innerText(), "Plain text");
    assert.equal(await page.locator(".cm-line > span").count(), 0);
    assert.equal(await page.locator("#preview").innerText(), "");
    await finish();
});

test("late language loads cannot replace the next document's language", async () => {
    const { page, open, highlighted, editOnly, finish } = await languagePage();
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
    await finish({ chunksLoaded: true });
});

test("multiple languages load locally and retain Vim automatic saving", async () => {
    const { temporary, page, open, highlighted, editOnly, finish } = await languagePage();
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
    await finish({ chunksLoaded: true });
});

test("Markdown aliases retain all layouts and restore the selected setting", async () => {
    const { page, open, editOnly, finish } = await languagePage();
    let previousLayout = "split";
    for (const [index, name] of ["note.md", "note.markdown", "note.mdown"].entries()) {
        await open(name);
        assert.equal(await page.locator("#filetype").innerText(), "Markdown");
        assert.equal(await page.locator("#layout-controls").isVisible(), true);
        if (previousLayout !== "edit") await until(async () => assert.equal(await page.locator("#words").isVisible(), true));
        else assert.equal(await page.locator("#words").isVisible(), false);
        if (previousLayout !== "edit") await until(async () => assert.equal(await page.locator("#preview h1").count(), 1));
        else assert.equal(await page.locator("#preview h1").count(), 0);
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
        previousLayout = layout;
    }
    await finish({ chunksLoaded: true });
});

test("plain text clears highlighting; binary files leave the current document intact", async () => {
    const { temporary, page, open, highlighted, editOnly, finish } = await languagePage();
    // Load a highlighted language first so returning to plain text must clear it.
    await open("script.js");
    await highlighted("JavaScript");
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
    await finish({ chunksLoaded: true });
});
