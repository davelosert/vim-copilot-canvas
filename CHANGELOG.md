# vim-copilot-canvas

## 1.1.0

### Minor Changes

- b74126c: Add persistent per-file history for manual edits, observed external changes, and individual or batched requests sent to Copilot, with native inline diffs in the main editor area, guarded per-change or whole-entry reverts, exact request context, and navigation to surviving text. Link SDK-confirmed Copilot file writes to retained requests using exact message and turn IDs, without inferring authorship from timing. Group consecutive Vim edits into the latest entry and mark sent requests with the Copilot icon. Preserve cursor and reading position when external edits reload a document.
  
  Distinguish sent requests from Copilot edits in a simplified timeline without prompt previews or turn links. Reopen requests in a read-only original-source view with prompts inline at their frozen selections, stacking batch selections and prompts in request order; clearly label selection-only context for older history. Store validated, deduplicated request-source snapshots locally without sending full source to Copilot. Show prompts beneath precisely matched changes using native CodeMirror diff widgets only when request/message evidence and the exact pre-edit source verify their placement.

### Patch Changes

- 7f033c0: Close the settings dialog after a successful save when no newer unsaved changes remain. Keep it open if saving fails or settings change while a save is in progress.
- 13e099a: Keep Cmd+A on macOS and Ctrl+A on Windows/Linux scoped to the Agent prompt while typing, instead of selecting text across the canvas.
- 215b355: Fix plugin packaging so users can install Vim Copilot Canvas and load its bundled canvas. Clarify marketplace registration, plugin installation, and catalog refresh steps.
- 7467bdf: Show Vim visual selections immediately on the cursor line, including linewise `V` and text objects such as `vi(`.
- ef30516: Improve large Markdown editing responsiveness by rendering previews in a server-side worker thread, preserving unchanged preview blocks and images, and suspending preview and outline processing while their panes are hidden.

## 1.0.0

### Major Changes

- 3c50ed2: Release Vim Copilot Canvas 1.0.0 for the GitHub Copilot App.
  
  - Edit workspace files with Vim-style navigation and editing modes, powered by CodeMirror.
  - Send inline prompts to the Copilot App, or collect feedback and change requests in batches with editable gutter comments, file navigation, pending request counts, and keyboard shortcuts.
  - Write GitHub-flavored Markdown with live previews, local workspace images including SVG, and bidirectional scroll sync.
  - Open Markdown web links with Cmd+click on macOS or Ctrl+click on Windows/Linux, with hover highlighting.
  - Navigate project files with a Vim-tree-style file explorer.
  - Explore Markdown headings in a live Outline tab with keyboard navigation and current-section highlighting.
  - Save edits automatically with batched background writes and reload the open document when its content changes on disk.
  - Customize editor themes, relative line numbers, keyboard shortcut indicators, and optional Vim mode in Agent panels.
  - Preview settings immediately, then save preferences or discard changes.
  - Use GitHub-styled Agent prompts, batch controls, and settings across light, dark, and custom editor themes.
  - Rebuild frontend assets and refresh the development canvas with a dev-only Reload canvas button.
  - Install the canvas through the repository's Copilot plugin marketplace.
