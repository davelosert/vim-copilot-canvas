# vim-copilot-canvas

## 1.0.0

### Major Changes

- 58402de: Release Vim Copilot Canvas 1.0.0 for the GitHub Copilot App.
  
  - Edit workspace files with Vim-style navigation and editing modes, powered by CodeMirror.
  - Send inline prompts to the Copilot App, with the option to group feedback and change requests before sending them.
  - Write GitHub-flavored Markdown with live previews.
  - Navigate project files with a Vim-tree-style file explorer.
  - Customize editor settings and themes, including relative line numbers.
  - Install the canvas through the repository's Copilot plugin marketplace.

### Minor Changes

- e4f36cd: Collect agent requests in batches with **Add to batch**, **Send batch**, and **Discard batch** actions and a pending request count.
  Show clickable comment icons in the left-hand gutter on the last selected line, with toggleable inline editing and deletion that preserve the original selection context.
  Click a batch list item to open its file, jump to its location, and expand its comment.
  Keep prompt shortcuts consistent: Enter sends immediately, Cmd/Ctrl+Enter adds to the batch, and Cmd/Ctrl+Shift+Enter sends the entire batch.
  Make Vim mode in Agent panels configurable, preserving it by default and allowing standard editing with a single Esc to close when disabled.
- fec06ac: Add a live Markdown Outline tab to the file explorer with heading navigation and current-section highlighting.
- b219a1b: Style the inline Agent prompt and review bar with Primer CSS buttons and theme tokens so they match GitHub's look in light, dark, and custom editor themes.
- a2e7e6e: Open Markdown web links with Cmd+click on macOS or Ctrl+click on Windows/Linux, with a hover highlight while holding the modifier.
- 0830cdb: Keep the Markdown editor and preview in sync when scrolling either pane.

### Patch Changes

- ed106f8: Add a dev-only Reload canvas button that rebuilds frontend assets and refreshes the panel.
- 587a5e0: Replace the toolbar wordmark with a Vim-focused SVG logo and support local workspace images in Markdown previews.
- 0bec6a9: Remove routine saving and saved indicators, and batch background file writes to keep typing responsive.
- 7ede76f: Automatically reload the open document when its content changes on disk.
- 753a398: Add a setting to show or hide keyboard shortcut indicators across the canvas.
  
  Preview settings immediately without flashing controls or rebuilding unrelated editor configuration. Save commits preferences to disk; Discard, closing the dialog, and Escape restore the last saved preferences.
  
  Style the settings dialog with Primer-inspired controls, spacing, and theme-aware colors.
