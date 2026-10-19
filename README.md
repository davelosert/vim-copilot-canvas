# Vim Markdown canvas

A user-scoped Copilot canvas using CodeMirror 6, `@replit/codemirror-vim`,
filename-based syntax highlighting via `@codemirror/language-data`, and a
sanitized live preview for Markdown. This is not Neovim:
Lua configuration and Neovim plugins are not loaded.

Open the `vim-markdown` canvas without input to browse the session's working
directory (its Markdown README/index or first supported text file opens first); if the session
has no working directory or it contains no supported text files, the editable welcome
document opens instead. Alternatively pass `{ "filePath": "/abs/doc.md" }`
and/or `{ "rootPath": "/abs/folder" }`.
Without `rootPath`, the explorer root is the file's nearest Git repository
(stopping at your home directory) or its folder. With only `rootPath`, a README
or index Markdown file is preferred. Existing UTF-8 text files of any extension
(or no extension) up to 2 MiB are supported; binary and non-UTF-8 files are rejected.
Languages are detected from filenames and loaded locally on demand. Unrecognized
files use plain text. Markdown (`.md`, `.markdown`, `.mdown`) keeps its Edit/Split/Preview
controls, live rendering, and word count; other files use the full editor pane
without preview controls. Returning to Markdown restores the selected layout.
Source/preview layout adapts to narrow panels.

## File explorer

The left sidebar lists all folders and files below the root, including dotfiles,
`.git`, `node_modules`, and binary files (which cannot be opened in the editor).
The first document opened automatically skips dotfiles and `node_modules`.
Symlinks or paths leaving the root are refused.

| Keys | Action |
| --- | --- |
| `Ctrl-w h` / `Ctrl-w w` / `:Ex` | Focus the explorer from the editor |
| `Ctrl-w l` / `Esc` | Return to the editor |
| `j` / `k`, `gg` / `G`, `Ctrl-d` / `Ctrl-u` | Move the selection |
| `l` / `Enter` / `o` | Open the file in the editor, or expand a folder |
| `h` | Collapse the folder, or jump to its parent |
| `Space` | Open the file but keep focus in the explorer |
| `R` / `q` / `:Lex` | Refresh / hide / toggle the explorer |
| `:e path` | Open a file relative to the root |

Click a file to preview it while staying in the explorer, double-click to edit
it, click a folder to toggle it, and drag the sidebar edge to resize it.
Hiding the sidebar gives the editor and preview its space; reopening restores
the sidebar width without changing the selected layout.
Switching files flushes pending edits to disk and starts a fresh undo history.
Conflicting drafts are preserved without overwriting disk changes.

Agent actions: `open_file { path }`, `list_files { dir? }`, `get_document`, and
`save`. The panel follows `open_file` within about two seconds.

- `i`, `a`, `o`, Escape, motions, visual selection, text objects, search,
  registers, macros, undo, redo, and repeat use the library's Vim engine.
- Edits save to disk automatically, including while typing in insert mode.
  Writes are serialized; edits made during a write are saved next without
  moving focus. `:w` and Cmd/Ctrl+S can flush pending changes or retry a failure.
- Recovery drafts are persisted before disk writes under `artifacts/drafts/`, keyed
  by canonical file path rather than panel ID. Keep that folder private: it
  contains document text, including the baseline used for conflict detection.
- Panels in one provider share document state. Stale draft writes and detected
  external file changes block saving. Use Copy draft before discarding a draft.
  An unmodified editor reloads external changes automatically.
- Saving uses a disk-content check and a same-directory atomic replacement.
  This is not an OS-level compare-and-swap: an unrelated writer racing in the
  narrow check-to-rename interval cannot be excluded. Atomic replacement can
  also break hard-link relationships and does not preserve extended metadata.
- Draft recovery survives iframe/provider reloads. Recovered drafts are saved
  automatically unless they conflict with disk changes. In-flight keystrokes
  are not guaranteed to survive an abrupt process crash.
- HTTP endpoints bind to loopback, validate Host/Origin, and require a random
  per-panel token for document operations. Frontend assets are bundled locally.
- The preview renders GitHub-flavored Markdown: tables with column alignment,
  task lists, strikethrough, autolinks, alerts (`> [!NOTE]` etc.), footnotes,
  and heading anchors. Like GitHub, element ids get a `user-content-` prefix and
  GFM's disallowed raw HTML tags are filtered.
- Preview HTML is sanitized, scripts and remote images are disabled, and only
  explicit HTTP(S) links open externally.

The extension runs on the session's execution host. A remote host needs its own
extension installation and file access; this local user installation does not
automatically synchronize to remote machines.

## Development

```sh
npm ci
npm run build
npm test
```

Browser tests use Playwright Chromium (`npx playwright install chromium` if
it is not installed). Build assets are shipped alongside `extension.mjs`;
reload extensions after changing provider code.
