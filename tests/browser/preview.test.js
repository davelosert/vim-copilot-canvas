import { afterEach, expect, it, vi } from "vitest";
import { renderMarkdown, wordCount } from "../../src/frontend/markdown.js";
import { createPreview } from "../../src/frontend/preview.js";

const previews = [];
afterEach(() => { for (const preview of previews.splice(0)) preview.dispose(); });

function fixture(options = {}) {
    const element = document.createElement("article");
    const words = document.createElement("span");
    const requests = [];
    const onError = vi.fn();
    const onRender = vi.fn();
    let text = "![Logo](logo.svg)";
    const loadImage = vi.fn((path, source) => new Promise((resolve, reject) => {
        requests.push({ path, source, resolve, reject });
    }));
    const readText = vi.fn(() => text);
    const renderSource = vi.fn(async (source) => ({ html: renderMarkdown(source), count: wordCount(source) }));
    const preview = createPreview({ element, words, readText, renderSource, loadImage, onError, onRender, ...options });
    previews.push(preview);
    return { element, words, requests, loadImage, readText, onRender, onError, preview, setText: (value) => { text = value; } };
}

it("ignores stale image responses after edits, document switches, and disposal", async () => {
    const { element, requests, onError, preview, setText } = fixture();
    preview.document({ name: "one.md", path: "/work/one.md" });
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ path: "/work/one.md", source: "logo.svg" });
    const first = element.querySelector("img");
    setText("![Other](other.svg)");
    preview.document({ name: "two.md", path: "/work/docs/two.md" });
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toMatchObject({ path: "/work/docs/two.md", source: "other.svg" });
    const second = element.querySelector("img");
    requests[0].resolve({ url: "data:image/png;base64,old" });
    await Promise.resolve();
    expect(first.hasAttribute("src")).toBe(false);
    expect(second.hasAttribute("src")).toBe(false);
    requests[1].resolve({ url: "data:image/png;base64,new" });
    await Promise.resolve();
    expect(second.getAttribute("src")).toBe("data:image/png;base64,new");
    setText("![Third](third.svg)");
    preview.document({ name: "three.md", path: "/work/three.md" });
    await expect.poll(() => requests.length).toBe(3);
    const third = element.querySelector("img");
    preview.dispose();
    requests[2].reject(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(element.querySelector("img")).toBe(third);
    expect(onError).not.toHaveBeenCalled();
});

it("reports failed image loads and clears images when switching to a non-Markdown file", async () => {
    const { element, requests, onError, preview, setText } = fixture();
    preview.document({ name: "one.md", path: "/work/one.md" });
    await expect.poll(() => requests.length).toBe(1);
    requests[0].reject(new Error("Image is outside the workspace."));
    await vi.waitFor(() => expect(element.querySelector(".image-error")?.textContent)
        .toBe("Image unavailable (Logo): Image is outside the workspace."));
    expect(onError).toHaveBeenCalledOnce();
    setText("![Other](other.svg)");
    preview.document({ name: "one.md", path: "/work/one.md" });
    await expect.poll(() => requests.length).toBe(2);
    preview.document({ name: "code.js", path: "/work/code.js" });
    requests[1].resolve({ url: "data:image/png;base64,old" });
    await Promise.resolve();
    expect(element.children.length).toBe(0);
    preview.dispose();
});

it("does not read or render hidden previews and catches up once with the latest text", async () => {
    const renderSource = vi.fn(async () => ({ html: "<p>Latest</p>", count: 1 }));
    const { element, preview, readText, setText } = fixture({ renderSource, visible: false });
    preview.document({ name: "one.md", path: "/work/one.md" });
    for (let index = 0; index < 20; index++) {
        setText(`Edit ${index}`);
        preview.edited();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readText).not.toHaveBeenCalled();
    expect(renderSource).not.toHaveBeenCalled();
    setText("Latest");
    preview.setVisible(true);
    await expect.poll(() => element.textContent).toBe("Latest");
    expect(renderSource).toHaveBeenCalledExactlyOnceWith("Latest");
});

it("coalesces edits during an in-flight render and never applies stale results", async () => {
    const jobs = [];
    const renderSource = vi.fn((source) => new Promise((resolve) => jobs.push({ source, resolve })));
    const { element, words, preview, setText } = fixture({ renderSource });
    preview.document({ name: "one.md", path: "/work/one.md" });
    for (let index = 0; index < 20; index++) {
        setText(`Latest ${index}`);
        preview.edited();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(jobs).toHaveLength(1);
    jobs[0].resolve({ html: "<p>Stale</p>", count: 1 });
    await expect.poll(() => jobs.length).toBe(2);
    expect(element.textContent).toBe("");
    expect(jobs[1].source).toBe("Latest 19");
    jobs[1].resolve({ html: "<p>Latest 19</p>", count: 2 });
    await expect.poll(() => element.textContent).toBe("Latest 19");
    expect(words.textContent).toBe("2 words");
});

it("ignores an in-flight result when hidden or switched to another document", async () => {
    const jobs = [];
    const renderSource = vi.fn(() => new Promise((resolve) => jobs.push(resolve)));
    const { element, preview, setText } = fixture({ renderSource });
    preview.document({ name: "one.md", path: "/work/one.md" });
    preview.setVisible(false);
    jobs[0]({ html: "<p>Hidden result</p>", count: 2 });
    await Promise.resolve();
    expect(element.textContent).toBe("");
    setText("New document");
    preview.document({ name: "two.md", path: "/work/two.md" });
    expect(renderSource).toHaveBeenCalledTimes(1);
    preview.setVisible(true);
    preview.document({ name: "code.js", path: "/work/code.js" });
    jobs[1]({ html: "<p>Old document</p>", count: 2 });
    await Promise.resolve();
    expect(element.textContent).toBe("");
});

it("preserves unchanged blocks, images and pending image responses around an edited paragraph", async () => {
    const { element, requests, loadImage, preview, setText } = fixture();
    setText("# Title\n\nBefore\n\n![Logo](logo.svg)\n\nAfter\n");
    preview.document({ name: "one.md", path: "/work/one.md" });
    await expect.poll(() => requests.length).toBe(1);
    const title = element.querySelector("h1"), image = element.querySelector("img"), after = element.lastElementChild;
    setText("# Title\n\nChanged\n\n![Logo](logo.svg)\n\nAfter\n");
    preview.edited();
    await expect.poll(() => element.querySelector("p").textContent).toBe("Changed");
    expect(element.querySelector("h1")).toBe(title);
    expect(element.querySelector("img")).toBe(image);
    expect(element.lastElementChild).toBe(after);
    expect(loadImage).toHaveBeenCalledTimes(1);
    requests[0].resolve({ url: "data:image/png;base64,new" });
    await Promise.resolve();
    expect(image.getAttribute("src")).toBe("data:image/png;base64,new");
});

it("retains whole-document Markdown semantics and sanitization through the renderer", async () => {
    const { element, preview, setText } = fixture();
    setText("# Same\n\n# Same\n\n[Reference][target]\n\n[target]: https://example.com\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert(1))\n");
    preview.document({ name: "one.md", path: "/work/one.md" });
    await expect.poll(() => element.querySelectorAll("h1").length).toBe(2);
    expect([...element.querySelectorAll("h1")].map((node) => node.id)).toEqual(["user-content-same", "user-content-same-1"]);
    expect(element.querySelector('a[href="https://example.com"]').rel).toBe("noopener noreferrer");
    expect(element.querySelector("script")).toBeNull();
    expect(element.querySelector('a[href^="javascript:"]')).toBeNull();
});

it("keeps root-level image fallbacks usable as patch anchors", async () => {
    const renderSource = vi.fn()
        .mockResolvedValueOnce({ html: '<p>Before</p><img data-image-source="broken.svg">', count: 1 })
        .mockResolvedValueOnce({ html: '<p>Changed</p><img data-image-source="broken.svg">', count: 1 });
    const { element, requests, preview } = fixture({ renderSource });
    preview.document({ name: "one.md", path: "/work/one.md" });
    await expect.poll(() => requests.length).toBe(1);
    requests[0].reject(new Error("Unavailable"));
    await expect.poll(() => element.querySelector(".image-error")?.textContent).toContain("Unavailable");
    const fallback = element.lastElementChild;
    preview.edited();
    await expect.poll(() => element.querySelector("p").textContent).toBe("Changed");
    expect(element.lastElementChild).toBe(fallback);
});

it("surfaces rendering failures without replacing the existing preview and permits retry", async () => {
    const renderSource = vi.fn().mockResolvedValueOnce({ html: "<p>Original</p>", count: 1 })
        .mockRejectedValueOnce(new Error("Render request failed"))
        .mockResolvedValueOnce({ html: "<p>Recovered</p>", count: 1 });
    const { element, preview, onError } = fixture({ renderSource });
    preview.document({ name: "one.md", path: "/work/one.md" });
    await expect.poll(() => element.textContent).toBe("Original");
    preview.edited();
    await expect.poll(() => onError.mock.calls.length).toBe(1);
    expect(onError.mock.calls[0][0].message).toBe("Render request failed");
    expect(element.textContent).toBe("Original");
    preview.edited();
    await expect.poll(() => element.textContent).toBe("Recovered");
});
