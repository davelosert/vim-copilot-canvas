import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { createEditor } from "../../src/frontend/editor.js";

let editor;
afterEach(() => {
    editor?.dispose();
    editor = undefined;
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

async function fixture(platform = "MacIntel", content = "Start [label](https://example.com/path) end", name = "file.md") {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    if ("userAgentData" in navigator) vi.spyOn(navigator, "userAgentData", "get").mockReturnValue(undefined);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const parent = document.createElement("div");
    parent.style.cssText = "width: 700px; height: 300px";
    document.body.append(parent);
    editor = createEditor({ parent, onEdit: vi.fn(), onSave: vi.fn() });
    editor.applyDocument({ name, content }, { kind: "switch" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { open, view: editor.view };
}

function pointer(view, text = "label") {
    const position = view.state.doc.toString().indexOf(text) + 2;
    const box = view.coordsAtPos(position);
    const coords = { clientX: box.left + 1, clientY: (box.top + box.bottom) / 2 };
    return (type, keys = {}) => {
        const target = document.elementFromPoint(coords.clientX, coords.clientY);
        const Event = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        const event = new Event(type, { ...coords, ...keys, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        return event;
    };
}

describe("Markdown modifier-click", () => {
    it("does not let compatibility mouse events reset a pointer hover", async () => {
        const { view } = await fixture();
        const mouse = pointer(view, "example");
        mouse("pointermove", { metaKey: true });
        expect(getComputedStyle(view.contentDOM).cursor).toBe("pointer");
        mouse("mousemove");
        expect(getComputedStyle(view.contentDOM).cursor).toBe("pointer");
        expect(view.dom.classList).toContain("cm-open-link-active");
    });

    it.each([
        ["MacIntel", "Meta", "metaKey"],
        ["Linux x86_64", "Control", "ctrlKey"],
        ["Win32", "Control", "ctrlKey"],
    ])("updates the cursor when entering and leaving links with the modifier already held on %s", async (platform, key, modifier) => {
        const { view } = await fixture(platform);
        const link = pointer(view);
        const outside = pointer(view, "Start");
        const defaultCursor = getComputedStyle(view.contentDOM).cursor;
        outside("pointermove");
        window.dispatchEvent(new KeyboardEvent("keydown", { key, [modifier]: true }));
        expect(getComputedStyle(view.contentDOM).cursor).toBe(defaultCursor);
        // Keep held-key state even when movement events omit modifier flags.
        link("pointermove");
        expect(getComputedStyle(view.contentDOM).cursor).toBe("pointer");
        expect(view.dom.classList).toContain("cm-open-link-active");
        outside("pointermove");
        expect(getComputedStyle(view.contentDOM).cursor).toBe(defaultCursor);
        expect(view.dom.classList).not.toContain("cm-open-link-active");
        link("pointermove");
        expect(getComputedStyle(view.contentDOM).cursor).toBe("pointer");
        window.dispatchEvent(new KeyboardEvent("keyup", { key }));
        expect(getComputedStyle(view.contentDOM).cursor).toBe(defaultCursor);
        expect(view.dom.classList).not.toContain("cm-open-link-active");
    });

    it.each([
        ["MacIntel", "metaKey", "ctrlKey"],
        ["Linux x86_64", "ctrlKey", "metaKey"],
        ["Win32", "ctrlKey", "metaKey"],
    ])("opens a link only with the platform modifier on %s", async (platform, modifier, wrongModifier) => {
        const { view, open } = await fixture(platform);
        const mouse = pointer(view);
        mouse("pointermove");
        expect(view.dom.classList).not.toContain("cm-open-link-active");
        mouse("click");
        mouse("click", { [wrongModifier]: true });
        expect(open).not.toHaveBeenCalled();

        const selection = view.state.selection;
        mouse("pointermove", { [modifier]: true });
        expect(view.dom.title).toContain("https://example.com/path");
        expect(getComputedStyle(view.contentDOM.querySelector(".cm-line span")).cursor).toBe("pointer");
        await expect.poll(() => view.dom.querySelector(".cm-open-link-layer .cm-open-link")).not.toBeNull();
        expect(mouse("mousedown", { [modifier]: true }).defaultPrevented).toBe(true);
        expect(mouse("click", { [modifier]: true }).defaultPrevented).toBe(true);
        expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/path", "_blank", "noopener,noreferrer");
        expect(view.state.selection.eq(selection)).toBe(true);
        expect(editor.readText()).toBe("Start [label](https://example.com/path) end");

        mouse("pointermove");
        expect(view.dom.classList).not.toContain("cm-open-link-active");
    });

    it("responds to modifier changes with a stationary pointer and clears on blur and mouse leave", async () => {
        const { view } = await fixture();
        const mouse = pointer(view);
        mouse("pointermove");
        const defaultCursor = getComputedStyle(view.contentDOM).cursor;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
        expect(view.dom.classList).toContain("cm-open-link-active");
        expect(getComputedStyle(view.contentDOM).cursor).toBe("pointer");
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
        expect(view.dom.classList).not.toContain("cm-open-link-active");
        expect(getComputedStyle(view.contentDOM).cursor).toBe(defaultCursor);
        mouse("pointermove", { metaKey: true });
        window.dispatchEvent(new Event("blur"));
        expect(view.dom.classList).not.toContain("cm-open-link-active");
        expect(getComputedStyle(view.contentDOM).cursor).toBe(defaultCursor);
        mouse("pointermove", { metaKey: true });
        view.contentDOM.dispatchEvent(new PointerEvent("pointerleave"));
        expect(view.dom.classList).not.toContain("cm-open-link-active");
        expect(getComputedStyle(view.contentDOM).cursor).toBe(defaultCursor);
    });

    it("preserves ordinary Vim clicks and editing, and ignores other mouse buttons and modified gestures", async () => {
        const { view, open } = await fixture();
        const mouse = pointer(view);
        await userEvent.click(view.contentDOM.querySelector(".cm-line"));
        expect(view.state.selection.main.head).toBeGreaterThan(0);
        await userEvent.keyboard("i");
        await userEvent.keyboard("X");
        await userEvent.keyboard("{Escape}");
        expect(editor.readText()).toContain("X");
        for (const keys of [{ button: 1 }, { button: 2 }, { altKey: true }, { shiftKey: true }]) {
            mouse("click", { metaKey: true, ...keys });
        }
        expect(open).not.toHaveBeenCalled();
    });

    it("handles bare URLs and current text after edits without enabling links in non-Markdown files", async () => {
        const { view, open } = await fixture("MacIntel", "Visit https://example.com/old.");
        const mouse = pointer(view, "example");
        mouse("pointermove", { metaKey: true });
        expect(view.dom.title).toMatch(/https:\/\/example\.com\/old$/);
        const from = view.state.doc.toString().indexOf("old");
        view.dispatch({ changes: { from, to: from + 3, insert: "new" } });
        expect(view.dom.classList).not.toContain("cm-open-link-active");
        mouse("click", { metaKey: true });
        expect(open).toHaveBeenLastCalledWith("https://example.com/new", "_blank", "noopener,noreferrer");

        editor.applyDocument({ name: "file.txt", content: "Visit https://example.com/new." }, { kind: "switch" });
        pointer(view, "example")("click", { metaKey: true });
        expect(open).toHaveBeenCalledOnce();
        expect(view.dom.classList).not.toContain("cm-open-link-active");
        editor.applyDocument({ name: "again.md", content: "Visit https://example.com/back." }, { kind: "switch" });
        pointer(view, "example")("click", { metaKey: true });
        expect(open).toHaveBeenLastCalledWith("https://example.com/back", "_blank", "noopener,noreferrer");
    });

    it("does not open code, non-web destinations, or clicks in the gutter", async () => {
        const content = "`https://example.com/code`\n[label](javascript:alert(1))\nhttps://example.com";
        const { view, open } = await fixture("MacIntel", content);
        pointer(view, "example")("click", { metaKey: true });
        pointer(view)("click", { metaKey: true });
        const gutter = view.dom.querySelector(".cm-gutterElement");
        gutter.dispatchEvent(new MouseEvent("click", { metaKey: true, bubbles: true, cancelable: true }));
        expect(open).not.toHaveBeenCalled();
        editor.dispose();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
        expect(open).not.toHaveBeenCalled();
    });
});
