import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { getCM } from "@replit/codemirror-vim";
import { createEditor } from "../../src/frontend/editor.js";

let editor;
afterEach(() => {
    editor?.dispose();
    document.body.replaceChildren();
});

function fixture(content, name = "example.md") {
    const parent = document.createElement("div");
    const next = document.createElement("button");
    next.textContent = "Next";
    document.body.append(parent, next);
    editor = createEditor({ parent, onEdit: vi.fn(), onSave: vi.fn() });
    editor.applyDocument({ content, name }, { kind: "switch" });
    editor.focus();
    return editor;
}

it.each(["example.md", "example.txt", "example.js"])("inserts a literal Tab without leaving insert mode in %s", async (name) => {
    const editor = fixture("text", name);
    await userEvent.keyboard("A{Tab}more");
    expect(editor.readText()).toBe("text\tmore");
    expect(editor.view.hasFocus).toBe(true);
    expect(getCM(editor.view).state.vim.insertMode).toBe(true);
});

it.each([
    ["- parent\n- child", "- parent\n    - child"],
    ["* parent\n* child", "* parent\n    * child"],
    ["1. parent\n2. child", "1. parent\n    2. child"],
    ["- parent\n- [ ] child", "- parent\n    - [ ] child"],
    ["- parent\n    - child", "- parent\n        - child"],
    ["- parent\n- ", "- parent\n    - "],
])("indents the current Markdown list item instead of inserting inside its text: %s", async (content, expected) => {
    const editor = fixture(content);
    await userEvent.keyboard("jA{Tab}");
    expect(editor.readText()).toBe(expected);
    expect(editor.view.hasFocus).toBe(true);
    expect(getCM(editor.view).state.vim.insertMode).toBe(true);
    await userEvent.keyboard("{Escape}u");
    expect(editor.readText()).toBe(content);
});

it("inserts Tab literally in fenced code that looks like a list", async () => {
    const editor = fixture("```\n- code\n```");
    await userEvent.keyboard("jA{Tab}");
    expect(editor.readText()).toBe("```\n- code\t\n```");
    expect(editor.view.hasFocus).toBe(true);
});

it("inserts Tab literally in a code block nested inside a list", async () => {
    const editor = fixture("- item\n\n    ```\n    - code\n    ```");
    editor.jumpTo(4);
    await userEvent.keyboard("A{Tab}");
    expect(editor.readText()).toBe("- item\n\n    ```\n    - code\t\n    ```");
});

it("inserts Tab at the cursor in prose after a list", async () => {
    const editor = fixture("- item\n\nparagraph");
    editor.jumpTo(3);
    await userEvent.keyboard("i{Tab}");
    expect(editor.readText()).toBe("- item\n\n\tparagraph");
});

it("keeps the cursor in the list text after indenting", async () => {
    const editor = fixture("- parent\n- child");
    await userEvent.keyboard("j0wi{Tab}new ");
    expect(editor.readText()).toBe("- parent\n    - new child");
});

it.each([
    ["- parent\n    - child", "- parent\n- child"],
    ["* parent\n    * child", "* parent\n* child"],
    ["1. parent\n    2. child", "1. parent\n2. child"],
    ["- parent\n    - [ ] child", "- parent\n- [ ] child"],
    ["- parent\n        - child", "- parent\n    - child"],
    ["- parent\n  - child", "- parent\n- child"],
    ["- parent\n- child", "- parent\n- child"],
])("outdents the current Markdown list line with Shift+Tab: %s", async (content, expected) => {
    const editor = fixture(content);
    await userEvent.keyboard("jA{Shift>}{Tab}{/Shift}");
    expect(editor.readText()).toBe(expected);
    expect(editor.view.hasFocus).toBe(true);
    expect(getCM(editor.view).state.vim.insertMode).toBe(true);
    if (content !== expected) {
        await userEvent.keyboard("{Escape}u");
        expect(editor.readText()).toBe(content);
    }
});

it("reverses Tab indentation with Shift+Tab and preserves the cursor", async () => {
    const editor = fixture("- parent\n- child");
    await userEvent.keyboard("j0wi{Tab}{Shift>}{Tab}{/Shift}new ");
    expect(editor.readText()).toBe("- parent\n- new child");
    expect(editor.view.hasFocus).toBe(true);
});

it.each([
    ["example.md", "    text", "text"],
    ["example.md", "\ttext", "text"],
    ["example.txt", "  text", "text"],
    ["example.txt", "text", "text"],
])("outdents ordinary text without losing focus: %s, %s", async (name, content, expected) => {
    const editor = fixture(content, name);
    await userEvent.keyboard("A{Shift>}{Tab}{/Shift}");
    expect(editor.readText()).toBe(expected);
    expect(editor.view.hasFocus).toBe(true);
    expect(getCM(editor.view).state.vim.insertMode).toBe(true);
});

it("does not interpret list-like plain text as Markdown after switching files", async () => {
    const editor = fixture("- markdown");
    editor.applyDocument({ content: "- text", name: "example.txt" }, { kind: "switch" });
    editor.focus();
    await userEvent.keyboard("A{Tab}");
    expect(editor.readText()).toBe("- text\t");
});

it.each(["- item", "text"])("does not edit a read-only document with Tab: %s", async (content) => {
    const editor = fixture(content);
    await userEvent.keyboard("A");
    editor.setReadOnly(true);
    await userEvent.keyboard("{Tab}");
    editor.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(editor.readText()).toBe(content);
});

it("does not insert or indent with Tab in normal mode", async () => {
    const editor = fixture("- item");
    await userEvent.keyboard("{Tab}");
    editor.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(editor.readText()).toBe("- item");
    expect(getCM(editor.view).state.vim.insertMode).toBe(false);
});
