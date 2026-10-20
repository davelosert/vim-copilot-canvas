# Features and usage

Vim Copilot Canvas is a GitHub Copilot App canvas for editing Markdown in your workspace. It is not a standalone application.

## Markdown editing

- Edit GitHub-flavored Markdown with Vim navigation and editing modes.
- Preview changes live, with bidirectional scroll sync between the editor and preview.
- Preview local images, including SVG, resolved relative to the Markdown file within the workspace. Images are limited to 5 MiB each; external images are not fetched.
- Save files locally. Conflicting drafts are preserved rather than overwriting disk changes.

## Agent prompts and batch comments

Inline prompts let you send a request directly to the Copilot App. Collect feedback or change requests in a batch to send them to the agent together.

Pending batch comments have clickable comment icons in the editor's left-hand gutter. Click an icon or **Edit** in the batch list to reopen a comment inline, then choose **Save changes**, **Delete comment**, or **Cancel**. Clicking a batch list item opens its file, jumps to its location, and expands the comment inline.

Each comment has its own icon, including when several comments refer to the same line. For multi-line selections, the icon appears on the last selected line. Click the same icon again to close the inline editor without saving changes. Edits retain the original selection context; saved comments survive reloads until the batch is sent or discarded.

New prompts use **Enter** to send immediately and **Cmd/Ctrl+Enter** to **Add to batch**. While a batch is pending, **Cmd/Ctrl+Shift+Enter** sends the entire batch, including the current prompt if nonempty. The batch bar shows the number of pending requests and offers **Send batch** and **Discard batch**; `:AgentSend` and `:AgentDiscard` remain available.

Settings includes **Vim mode in Agent panel**, enabled by default and saved across sessions. Disable it to use standard editing in prompts and batch comments, with a single **Esc** to close; the main editor stays in Vim mode. Changing this setting applies to open panels without clearing their text.

## File explorer and outline

The file explorer provides Vim-tree-style navigation through workspace files.

Switch the sidebar to **Outline** to navigate the current Markdown document, including unsaved edits. ATX (`#`) and Setext (underlined) headings appear in document order; code blocks are excluded. Use `j` / `k`, arrows, `gg` / `G`, or Home / End to select a heading, then Enter / `l` / `o` to jump to it; Space jumps while keeping outline focus.

Clicking a heading focuses its source line; preview-only mode opens the source alongside the preview. `Ctrl+w h` / `:Ex` focuses the selected sidebar tab's content, and Esc / `Ctrl+w l` returns to the editor.

## Settings and preferences

Settings apply immediately as an in-memory preview; only **Save** writes changed preferences to disk. **Discard**, closing the dialog, and Escape restore the last saved preferences without writing.

While a save is in flight, duplicate saves and dismissal are blocked; further previews remain editable but require another explicit Save. Failed saves keep the preview and display an error so it can be retried or discarded. Opening the dialog refreshes persisted preferences without letting a stale read overwrite newer local edits.

Only changed editor compartments are reconfigured; changing shortcut visibility does not rebuild themes or line numbers. The backend uses atomic JSON writes so preferences survive restarts without partially written files.
