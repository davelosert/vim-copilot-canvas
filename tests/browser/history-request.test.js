import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { EditorView } from "@codemirror/view";
import { createHistoryRequest } from "../../src/frontend/history-request.js";

const stylesheet = await (await fetch("/editor.css")).text();

const mounted = [];
afterEach(() => { for (const review of mounted.splice(0)) review.dispose(); document.body.replaceChildren(); });
const selection = (from, to, text) => ({
    selection: { start: { line: from[0], character: from[1] }, end: { line: to[0], character: to[1] } }, text,
});
function fixture(entry, path = "/a.md") {
    const parent = document.createElement("div");
    const style = document.createElement("style");
    style.textContent = stylesheet;
    document.body.append(style);
    parent.id = "history-review-diff";
    parent.style.cssText = "width: 600px; height: 650px";
    document.body.append(parent);
    const review = createHistoryRequest({ parent, entry: { prompt: "Exact batch message", ...entry }, path });
    mounted.push(review);
    return { parent, review, view: () => EditorView.findFromDOM(parent.querySelector(".cm-editor")) };
}

test("historical prompts appear after their selected lines, including duplicate-line and UTF-16 CRLF selections", async () => {
    const content = "heading\r\nalpha 😀beta\r\nnext\r\ntail";
    const f = fixture({
        snapshots: [{ path: "/a.md", content }],
        items: [
            { path: "/a.md", snapshot: 0, prompt: "First <script>alert(1)</script>", attachments: [selection([1, 6], [2, 0], "😀beta\r\n")] },
            { path: "/a.md", snapshot: 0, prompt: "Second prompt", attachments: [selection([1, 0], [1, 5], "alpha")] },
            { path: "/a.md", snapshot: 0, prompt: "Tail prompt", attachments: [selection([3, 0], [3, 4], "tail")] },
        ],
    });
    await expect.poll(() => f.parent.querySelectorAll(".history-sent-prompt").length).toBe(3);
    const cards = [...f.parent.querySelectorAll(".history-sent-prompt")];
    expect(cards[0].previousElementSibling.textContent).toBe("alpha 😀beta");
    expect(cards[1].previousElementSibling).toBe(cards[0]);
    expect(cards[2].previousElementSibling.textContent).toBe("tail");
    expect(cards[0].textContent).toContain("First <script>alert(1)</script>");
    expect(f.parent.querySelectorAll("script")).toHaveLength(0);
    expect(f.parent.querySelector(".history-request-selection").textContent).toBe("alpha");
    expect(f.view().state.readOnly).toBe(true);
    expect(f.view().state.doc.toString()).toBe(content.replace(/\r\n/g, "\n"));
    expect(f.parent.querySelector("select")).toBeNull();
    expect(f.parent.querySelector("button")).toBeNull();
    const view = f.view();
    f.review.theme(EditorView.theme({ "&": { color: "rgb(1, 2, 3)" } }));
    expect(f.view()).toBe(view);
    expect(getComputedStyle(view.dom).color).toBe("rgb(1, 2, 3)");
    view.focus();
    await userEvent.keyboard("ignored");
    expect(view.state.doc.toString()).toBe(content.replace(/\r\n/g, "\n"));
});

test("multi-file and different-revision batches stack every selection and prompt in request order", async () => {
    const item = (path, snapshot, text) => ({ path, snapshot, prompt: `Request ${snapshot}`, attachments: [selection([0, 0], [0, text.length], text)] });
    const f = fixture({
        type: "batch",
        snapshots: [{ path: "/a.md", content: "old" }, { path: "/a.md", content: "new" }, { path: "/b.js", content: "code" }],
        items: [item("/a.md", 0, "old"), item("/a.md", 1, "new"), item("/b.js", 2, "code")],
    }, "/b.js");
    const sections = [...f.parent.querySelectorAll(".history-request-item")];
    expect(sections).toHaveLength(3);
    expect(sections.map((section) => EditorView.findFromDOM(section.querySelector(".cm-editor")).state.doc.toString())).toEqual(["old", "new", "code"]);
    expect(sections.map((section) => section.querySelector(".history-sent-prompt pre").textContent)).toEqual(["Request 0", "Request 1", "Request 2"]);
    expect(sections.map((section) => section.querySelector("h4").textContent)).toEqual(["1. /a.md", "2. /a.md", "3. /b.js"]);
    expect(f.parent.querySelector("select, button")).toBeNull();
});

test("legacy selections show their original line numbers and clearly disclose unavailable full-file context", async () => {
    const f = fixture({ items: [{ path: "/a.md", prompt: "Old request", attachments: [selection([49, 6], [50, 3], "excerpt\nend")] }] });
    expect(f.view().state.doc.toString()).toBe("excerpt\nend");
    expect(f.parent.querySelector('[role="status"]').textContent).toContain("line 50, column 7");
    expect(f.parent.textContent).toContain("full historical file is unavailable");
    await expect.poll(() => f.parent.querySelector(".cm-lineNumbers").textContent).toContain("50");
    expect([...f.parent.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    expect(f.parent.querySelector(".history-sent-prompt").textContent).toContain("Old request");
});
