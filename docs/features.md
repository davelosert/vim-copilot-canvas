# Features and usage

Vim Copilot Canvas is a GitHub Copilot App canvas for editing Markdown in your workspace. It is not a standalone application.

## Markdown editing

- Edit GitHub-flavored Markdown with Vim navigation and editing modes.
- Preview changes live, with bidirectional scroll sync between the editor and preview.
- Markdown preview parsing runs in a worker thread on the canvas server, and unchanged preview blocks and images are preserved across edits. Edit-only mode suspends preview processing and hides the preview's word count; hidden outlines also suspend updates and catch up when reopened.
- Preview local images, including SVG, resolved relative to the Markdown file within the workspace. Images are limited to 5 MiB each; external images are not fetched.
- Open web links from the Markdown editor with **Cmd+click** on macOS or **Ctrl+click** on Windows/Linux. Holding the modifier highlights the hovered link and shows the system link-pointer cursor; ordinary clicks still position the cursor.
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

## Quick open

Press **Cmd+P** on macOS or **Ctrl+P** on Windows/Linux, run `:Files`, press `<Space>f` in normal mode, or press `f` in the file explorer to open a fuzzy file finder for the workspace. Mod+P replaces Vim's `Ctrl+p` in the editor. In normal mode `<Space>` waits up to a second for `f`; any other key, or the timeout, still moves the cursor right.

Type any part of a path. Matching is fuzzy and smart-case, and it favours file names, word boundaries, and consecutive characters. Files ignored by `.gitignore` (or by `.git` and `node_modules` outside a Git repository) are excluded. With an empty query, the finder lists recently opened files first; recents are remembered per workspace and shared across panels.

Use ↑/↓, `Ctrl+n` / `Ctrl+p`, or `Ctrl+j` / `Ctrl+k` to move through results, Enter or a click to open, and Esc to close. Opening a file follows the same unsaved-draft and conflict prompts as the explorer.

## Document history

Choose **History** beside Files and Outline for a newest-first timeline of the current file. **Vim edit** and **External edit** entries show added/removed line counts; selecting an edit shows CodeMirror's inline unified diff **directly in the main editor area**, not in the sidebar. Deleted text, word-level highlights, and collapsed unchanged sections appear beside the file's source lines. **Return to editing** or Escape leaves review and restores the live Vim editor, preserving its selection, undo history, and reading position. The Markdown preview continues to show the live file, not the historical snapshot.

**Sent to Copilot** and **Sent batch** entries have outlined request markers and **REQUEST** badges, distinct from the **EDIT** badges and green treatment of SDK-confirmed Copilot writes. Both display the Copilot icon. The sidebar omits prompt previews and agent-turn correlation links.

Selecting a request restores a read-only view of the original document, with highlighted selections and the exact sent prompts inline after their selected lines. The source is frozen when the inline prompt is opened, so later edits do not shift the historical request to a guessed location. Batches list all original selections and prompts underneath each other, in request order, with numbered file headers and separated panels; there is no context selector or Previous/Next prompt navigation. **Exact outgoing message** reveals the complete message sent to Copilot. A multi-file batch appears once in each affected file's history. Older requests without a full source snapshot show only their saved selection, with its original line numbers and an explicit notice that the full historical file is unavailable. Reviewing a request does not resend it or restore pending batch comments.

Copilot edit diffs can also show the corresponding prompt below a changed line using CodeMirror's native block widgets. This requires an exact SDK request/message association, the saved request document matching the diff's entire pre-edit snapshot, and a precise changed range contained in the original selection (including a selected line's trailing newline). Deleted-line prompts appear after the deleted block. No prompt is placed for stale snapshots, unrelated or unretained requests, legacy selection-only history, unchanged selections, or imprecise diffs. These panels verify matching source ranges, not exclusive authorship or proof that a particular prompt caused the edit; if several requests match, all are shown. Reverting a change removes its panel.

The diff is a virtualized, non-editable review surface. When the current file exactly matches the selected entry's latest displayed text, use **Revert this change** on a changed block or **Revert all changes in this entry** to restore the earlier text while preserving the current file's line endings. Reverts ask for confirmation, save through the normal conflict-aware editor flow, and can be undone with `u` in the main editor. A historical snapshot that differs from the current file cannot be reverted; the file is rechecked before applying a revert, so newer edits are not silently overwritten. After reverting one block, the remaining blocks can still be reverted.

Only successful sends through this canvas appear as request events. Pending, edited, discarded, and failed-to-send batch comments do not appear. A sent request does not mean Copilot completed the change.

When the SDK reports a committed built-in file edit for a file already opened in this canvas, its observed external change is labeled **Copilot file write**. Exact SDK message and turn IDs associate it internally with retained canvas requests; this evidence persists but is not displayed as prompt previews or correlation links in the sidebar. If several requests were consumed in that turn, the association includes all matching requests rather than claiming one caused the change. A batch is associated as a whole, not a guessed individual instruction. Explicit parent-tool IDs can carry this association into subagent writes.

This identifies a Copilot file write, not exclusive authorship of every line in the observed snapshot: concurrent edits or multiple writes between observations may be included. Without committed `fileEdits` metadata, disk changes remain **External edit**; shell commands, other editors, other sessions, closed-canvas activity, and older SDKs are not attributed by timing or tool arguments. Deletions are not captured as text revisions. No retrospective attribution is inferred for existing history.

Use `j` / `k` or arrows to move through history, Home / `g` and End / `G` for first/last, Enter to review an event, and Escape to return to the editor. Left/Right switches the focused sidebar tab. **Jump to current text** navigates only when the historical text still has a unique exact match in the current document; changed, deleted, or ambiguous locations are labeled historical instead of jumping to an unrelated line. Referenced files outside the current explorer root cannot be opened or inspected through history.

Consecutive Vim edits extend the most recent Vim entry, preserving its original before-text and updating its after-text and timestamp, regardless of pauses or how long editing takes. External edits and sent requests separate these groups. History retains at most **100 entries or 20 MiB per file**, including referenced batch payloads and the disk baseline, pruning oldest entries first. The pane reports when older entries have been pruned. Reverting or undoing a grouped edit back to its original text removes the resulting no-op entry.

History persists locally across canvas and app restarts under `$COPILOT_HOME/extensions/vim-canvas/artifacts/history` (`~/.copilot` when `COPILOT_HOME` is unset). The development canvas uses `vim-canvas-dev` instead. These files contain prior document contents, prompts, selections, and original request-source snapshots; they are not committed to the repository. Full source snapshots are stored locally, not added to the message sent to Copilot, and identical snapshots for the same file are stored once per sent batch. They count toward the history byte limit; pending batch contexts are also limited to 20 MiB. Shared batch payloads are removed after their last retained reference is pruned; small delivery receipts remain to prevent a retry from sending an already delivered request again. Unresolved delivery payloads are separately bounded to 100 records / 20 MiB per installation namespace. Storage errors are shown rather than silently dropping capture. If a delivery's outcome is unknown after a crash, check the conversation before resending.

External edits are observed when the document is polled while the canvas is visible, when reopened, or after SDK-confirmed file writes to already-opened documents; no workspace-wide watcher runs. Multiple disk writes between polls, or while the app is closed, can appear as one net change. External timestamps describe observation time, not the precise write time. Renaming a file starts a separate history identity. There is no global storage limit across files, and history is not a backup, Git history, or complete audit log.

Same-file external updates map the cursor and source viewport through the diff instead of resetting them to the top, and preserve the preview's reading position. Existing automatic reload behavior remains: external disk changes replace the draft, but pending local text is first persisted for history and recovery. If that capture fails or a concurrent draft cannot be safely captured, reload stops with an error rather than silently discarding the local text.

## Settings and preferences

Settings apply immediately as an in-memory preview; only **Save** writes changed preferences to disk. **Discard**, closing the dialog, and Escape restore the last saved preferences without writing.

While a save is in flight, duplicate saves and dismissal are blocked; further previews remain editable but require another explicit Save. Failed saves keep the preview and display an error so it can be retried or discarded. Opening the dialog refreshes persisted preferences without letting a stale read overwrite newer local edits.

Only changed editor compartments are reconfigured; changing shortcut visibility does not rebuild themes or line numbers. The backend uses atomic JSON writes so preferences survive restarts without partially written files.
