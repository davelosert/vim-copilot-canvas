import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { EditorView } from "@codemirror/view";
import { createHistoryDiff } from "../../src/frontend/history-diff.js";

const mounted = [];
afterEach(() => { for (const view of mounted.splice(0)) view.dispose(); document.body.replaceChildren(); });

const before = "Header\n\nOld first block\n\nKeep one\nKeep two\nKeep three\nKeep four\nKeep five\n\nOld second block\n";
const after = before.replace("Old first block", "New first block").replace("Old second block", "New second block");

test("native unified diffs support inline request panels and remove them after the matched edit is reverted", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const original = "Header\nOld line\nTail\n", latest = "Header\nNew line\nTail\n";
    let current = latest;
    const request = { id: "request", status: "sent", messageId: "message", snapshots: [{ path: "/a", content: original }],
        items: [{ path: "/a", snapshot: 0, prompt: "Replace <script>Old</script>", attachments: [{
            text: "Old line", selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
        }] }] };
    const onError = vi.fn();
    mounted.push(createHistoryDiff({
        parent, before: original, after: latest, path: "/a",
        agent: { requestIds: ["request"], messageIds: ["message"] }, requests: [request],
        canRevert: (expected) => expected === current, onError,
        onRevert: async (_expected, next) => { current = next; return true; },
    }));
    await expect.poll(() => parent.querySelector(".history-sent-prompt")).toBeTruthy();
    const card = parent.querySelector(".history-sent-prompt");
    expect(card.previousElementSibling.textContent).toBe("OldNew line");
    expect(card.previousElementSibling.querySelector(".cm-deletedText").textContent).toBe("Old");
    expect(card.textContent).toContain("Replace <script>Old</script>");
    expect(card.querySelector("script")).toBeNull();
    expect(card.previousElementSibling.classList.contains("cm-inlineChangedLine")).toBe(true);
    await userEvent.click([...parent.querySelectorAll("button")].find((button) => button.textContent === "Revert all changes in this entry"));
    await expect.poll(() => current).toBe(original);
    expect(parent.querySelector(".history-sent-prompt")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
});

test("a deleted-line prompt is placed below CodeMirror's deleted block, not below an unrelated surviving line", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const original = "Header\nOld line\nTail\n";
    mounted.push(createHistoryDiff({
        parent, before: original, after: "Header\nTail\n", path: "/a",
        agent: { requestIds: ["request"], messageIds: ["message"] },
        requests: [{ id: "request", status: "sent", messageId: "message",
            snapshots: [{ path: "/a", content: original }],
            items: [{ path: "/a", snapshot: 0, prompt: "Delete this line", attachments: [{
                text: "Old line\n", selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
            }] }],
        }],
        canRevert: () => false, onRevert: vi.fn(), onError: vi.fn(),
    }));
    await expect.poll(() => parent.querySelector(".history-sent-prompt")).toBeTruthy();
    const card = parent.querySelector(".history-sent-prompt");
    expect(card.previousElementSibling.classList.contains("cm-deletedChunk")).toBe(true);
    expect(card.nextElementSibling.textContent).toBe("Tail");
});
async function fixture({ current = after, revert, available = true } = {}) {
    const parent = document.createElement("div");
    parent.style.cssText = "width: 600px; height: 600px";
    document.body.append(parent);
    const onError = vi.fn();
    const onRevert = vi.fn(revert ?? (async (_expected, next) => { current = next; return true; }));
    const diff = createHistoryDiff({
        parent, before, after, canRevert: (expected) => available && current === expected, onRevert, onError,
    });
    mounted.push(diff);
    await expect.poll(() => parent.querySelector(".cm-editor")).toBeTruthy();
    const find = (text) => [...parent.querySelectorAll("button")].filter((button) => !button.hidden && button.textContent === text);
    return { parent, diff, onError, onRevert, find, current: () => current, change: (value) => { current = value; } };
}

test("native unified view highlights inline changes and reverts a single chunk without touching the other", async () => {
    const f = await fixture();
    expect(f.find("Next change")).toHaveLength(0);
    expect(f.find("Previous change")).toHaveLength(0);
    await expect.poll(() => f.find("Revert this change").length).toBeGreaterThan(0);
    expect(f.parent.querySelector('[aria-label="Inline history diff"]').getAttribute("contenteditable")).toBe("true");
    await userEvent.click(f.find("Revert this change")[0]);
    await expect.poll(() => f.onRevert.mock.calls.length).toBe(1);
    expect(f.current()).toContain("Old first block");
    expect(f.current()).toContain("New second block");
    expect(f.parent.textContent).toContain("Reverts update the file");
    await userEvent.click(f.find("Revert all changes in this entry")[0]);
    await expect.poll(() => f.current()).toBe(before);
    expect(f.onError).not.toHaveBeenCalled();
});

test("historical snapshots have disabled revert controls", async () => {
    const f = await fixture({ current: "newer current content" });
    expect(f.find("Revert all changes in this entry")[0].disabled).toBe(true);
    await expect.poll(() => f.find("Revert this change").length).toBeGreaterThan(0);
    expect(f.find("Revert this change").every((button) => button.disabled)).toBe(true);
    expect(f.parent.textContent).toContain("Historical snapshot");
});

test("stale content and failed saves remain visible without modifying the displayed snapshot", async () => {
    const f = await fixture({ revert: async () => { throw new Error("Disk changed"); } });
    await userEvent.click(f.find("Revert all changes in this entry")[0]);
    await expect.poll(() => f.onError.mock.calls.length).toBe(1);
    expect(f.parent.textContent).toContain("Disk changed");
    expect(f.parent.querySelector(".cm-content").textContent).toContain("New first block");
    f.change("concurrent edit");
    await userEvent.click(f.find("Revert all changes in this entry")[0]);
    expect(f.onRevert).toHaveBeenCalledTimes(1);
});

test("canceling a revert leaves the snapshot intact", async () => {
    const f = await fixture({ revert: async () => false });
    await userEvent.click(f.find("Revert all changes in this entry")[0]);
    expect(f.current()).toBe(after);
    expect(f.parent.querySelector(".cm-content").textContent).toContain("New first block");
});

test("CRLF is preserved through per-chunk reverts", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    let current = "heading\r\nnew\r\n";
    const onRevert = vi.fn(async (_expected, next) => { current = next; return true; });
    mounted.push(createHistoryDiff({
        parent, before: "heading\r\nold\r\n", after: current, canRevert: (expected) => expected === current, onRevert, onError: vi.fn(),
    }));
    await expect.poll(() => [...parent.querySelectorAll("button")].find((button) => !button.hidden && button.textContent === "Revert this change")).toBeTruthy();
    await userEvent.click([...parent.querySelectorAll("button")].find((button) => !button.hidden && button.textContent === "Revert this change"));
    await expect.poll(() => current).toBe("heading\r\nold\r\n");
});

test("selection and theme updates during a pending revert do not invalidate its transaction", async () => {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const f = await fixture({ revert: async (_expected, next) => { await pending; f.change(next); return true; } });
    await expect.poll(() => f.find("Revert this change").length).toBeGreaterThan(0);
    await userEvent.click(f.find("Revert this change")[0]);
    const view = EditorView.findFromDOM(f.parent.querySelector(".cm-editor"));
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    f.diff.theme([]);
    finish();
    await expect.poll(() => f.parent.textContent).toContain("Reverts update the file");
    expect(f.current()).toContain("Old first block");
    expect(f.onError).not.toHaveBeenCalled();
});

test("whole-entry reverts preserve current line endings even when the older snapshot used LF", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    let current = "heading\r\nnew\r\n";
    mounted.push(createHistoryDiff({
        parent, before: "heading\nold\n", after: current, canRevert: (expected) => expected === current,
        onRevert: async (_expected, next) => { current = next; return true; }, onError: vi.fn(),
    }));
    await userEvent.click([...parent.querySelectorAll("button")].find((button) => button.textContent === "Revert all changes in this entry"));
    await expect.poll(() => current).toBe("heading\r\nold\r\n");
});
