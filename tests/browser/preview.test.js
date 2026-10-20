import { expect, it, vi } from "vitest";
import { createPreview } from "../../src/frontend/preview.js";

function fixture() {
    const element = document.createElement("article");
    const words = document.createElement("span");
    const requests = [];
    const onError = vi.fn();
    const onRender = vi.fn();
    let text = "![Logo](logo.svg)";
    const loadImage = vi.fn((path, source) => new Promise((resolve, reject) => {
        requests.push({ path, source, resolve, reject });
    }));
    const preview = createPreview({ element, words, readText: () => text, loadImage, onError, onRender });
    return { element, requests, onError, preview, setText: (value) => { text = value; } };
}

it("ignores stale image responses after edits, document switches, and disposal", async () => {
    const { element, requests, onError, preview, setText } = fixture();
    preview.document({ name: "one.md", path: "/work/one.md" });
    expect(requests[0]).toMatchObject({ path: "/work/one.md", source: "logo.svg" });
    const first = element.querySelector("img");
    setText("![Other](other.svg)");
    preview.document({ name: "two.md", path: "/work/docs/two.md" });
    expect(requests[1]).toMatchObject({ path: "/work/docs/two.md", source: "other.svg" });
    const second = element.querySelector("img");
    requests[0].resolve({ url: "data:image/png;base64,old" });
    await Promise.resolve();
    expect(first.hasAttribute("src")).toBe(false);
    expect(second.hasAttribute("src")).toBe(false);
    requests[1].resolve({ url: "data:image/png;base64,new" });
    await Promise.resolve();
    expect(second.getAttribute("src")).toBe("data:image/png;base64,new");
    preview.document({ name: "two.md", path: "/work/docs/two.md" });
    const third = element.querySelector("img");
    preview.dispose();
    requests[2].reject(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(element.querySelector("img")).toBe(third);
    expect(onError).not.toHaveBeenCalled();
});

it("reports failed image loads and clears images when switching to a non-Markdown file", async () => {
    const { element, requests, onError, preview } = fixture();
    preview.document({ name: "one.md", path: "/work/one.md" });
    requests[0].reject(new Error("Image is outside the workspace."));
    await vi.waitFor(() => expect(element.querySelector(".image-error")?.textContent)
        .toBe("Image unavailable (Logo): Image is outside the workspace."));
    expect(onError).toHaveBeenCalledOnce();
    preview.document({ name: "one.md", path: "/work/one.md" });
    preview.document({ name: "code.js", path: "/work/code.js" });
    requests[1].resolve({ url: "data:image/png;base64,old" });
    await Promise.resolve();
    expect(element.children.length).toBe(0);
    preview.dispose();
});
