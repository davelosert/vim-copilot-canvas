# Development

Use Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`. `npm test` builds the production bundle and runs all tests; `npm run build` rebuilds the shipped assets only.

| Command | Scope |
| --- | --- |
| `npm run test:unit` | Logic and editor state |
| `npm run test:integration` | Filesystem and HTTP behavior |
| `npm run test:browser` | UI components and app in Vitest Browser Mode |
| `npm run test:e2e` | Built app and HTTP pages in Chromium and WebKit |
| `npm run test:watch` | Interactive test mode |

Install both browser engines locally with `npx playwright install chromium webkit` before running the end-to-end tests.

## Development canvas

Repository sessions discover `.github/extensions/vim-canvas-dev/extension.mjs`, which registers **Vim Copilot Canvas (Dev)** (`vim-markdown-dev`). Open it to run the backend and serve assets from the current checkout.

Install dependencies with `npm ci`. After frontend changes, click **Reload canvas** in the dev toolbar to rebuild assets from the current checkout and refresh the panel. The button preserves the current document draft before refreshing; rebuild failures appear in the canvas and leave the editor open for a retry. Reload extensions after backend or provider changes. Dev drafts and pending batches are stored separately per session; explicit file saves still update the files in the checkout.

## Source layout and ownership

```text
extension.mjs          SDK discovery entry and provider wiring
com.github.copilot/
  extensions/
    vim-canvas/
      extension.mjs    Installed plugin entry; imports the root provider wiring
src/frontend/          Browser application and feature factories
src/backend/           HTTP transport, routes, delivery, and persistent stores
src/shared/             Browser/Node-safe theme catalog
public/                 HTML shell and stylesheet
resources/              Bundled welcome document
assets/                 Generated editor and Markdown worker bundles, Primer CSS, and lazy language chunks
tests/                  unit, integration, browser, e2e, and fixture helpers
```

The plugin uses Agent Plugins 1.0 (`$schema` in `plugin.json`). Copilot discovers its canvas from `com.github.copilot/extensions/vim-canvas/extension.mjs`, which imports the root entry so assets and resources still resolve from the installation root. A custom namespace in the manifest's `extensions` map does not register a Copilot extension; the legacy top-level extension path configuration is not used in this format. Keep the production entry separate from `.github/extensions/vim-canvas-dev/extension.mjs`, which is only for repository development.

The frontend uses vanilla DOM and ES modules; `app.js` composes features and `main.js` is the production entry. Inline Agent prompts and batch actions use [Primer CSS](https://primer.style/css), not React; the locally served `primer.css` includes only needed primitives and theme tokens, without a global reset or runtime dependency. New Primer surfaces should use `primer-scope` and matching colour-mode attributes; theme updates must preserve the host's colour-mode attributes.

Markdown previews are parsed and sanitized on the canvas server: the frontend posts the source to `/api/render`, and the backend renders it in a shared Node `worker_threads` worker (bundled to `assets/server/markdown-worker.mjs`, because installed plugins have no `node_modules`) so the extension's event loop stays free. Browser Web Workers were abandoned because the app's WebKit webview silently kills them after parsing large documents, leaving the preview empty with no error. The preview keeps one request in flight, coalesces pending edits, and discards stale results after edits, document switches, or hiding the pane; render failures surface in the existing notice UI, and a crashed worker is restarted on the next request. DOM updates preserve common unchanged top-level blocks; Edit-only mode skips preview work entirely, and hidden outlines defer parsing until reopened.

The document controller manages edits, serialized saves, file switching, reloads, polling, and conflicts independently of the UI. It reloads the open document when disk content changes, replacing unsynced edits, and temporarily makes the editor read-only during reload. Backend routes use persistent stores; shared modules must remain safe to import in both browser and Node.js environments. Dispose independently mounted apps after each test.

`HistoryStore` captures file changes centrally under the document lock and serializes durable history updates across provider processes using a filesystem lock. Production and development entry points supply separate user-global history roots so history outlives installation versions and development sessions; inject temporary roots in tests. Sent request payloads are shared across affected file histories, and delivery records distinguish sent events from pending/unknown delivery outcomes. Request history is independent of the pending `ReviewStore` batch.

`agent-history.mjs` subscribes to live SDK events in both entry points. Only committed `tool.execution_complete.fileEdits` count as file-write evidence; tool arguments and shell path hints do not. Capture is limited to already-opened documents. Exact user-message/turn IDs (or matching interaction IDs), plus explicit parent-tool IDs for subagents, associate retained requests with writes. Missing metadata leaves the request association unknown. Event handling is serialized, bounded correlation maps are session-local, capture failures are logged, and persisted evidence is included in normal history retention. Tests cover polling before tool completion, delayed delivery finalization, partial tool failures, missing metadata, and unrelated prompts.

History diff and sent-request review mount separate read-only CodeMirror views in the main source pane, without putting historical text into the live buffer. Returning to editing preserves the live editor instance and undo stack. Switching records keeps the previous review mounted while loading and replaces it without revealing the live editor; stale responses cannot replace a newer selection. Guarded revert actions still save through the document controller; the preview always represents the live document. Request reviews remain stable across polling rather than rebuilding the historical source on each new timeline event.

`agent.js` freezes full source context with selections when a prompt opens. Delivery routes validate each selection's UTF-16 coordinates and exact text against that context using `shared/selection-range.js`. Context is local-only metadata, never an extra SDK message attachment. Pending `ReviewStore` comments retain it across edits and restarts, with a 20 MiB pending-batch limit. `HistoryStore.prepare` deduplicates source by canonical path and exact content into a `snapshots` array; each request item refers to a snapshot index, included in retry fingerprints and retention accounting. Older payloads without snapshots remain readable. `history-request.js` renders selection highlights and immutable inline prompt widgets, stacking batch selections in request order with numbered, separated file panels. Legacy requests use explicitly labeled selection-only excerpts, not reconstructed current-document positions. The sidebar intentionally omits prompt previews and request/turn links; backend provenance remains available.

Change detail loads retained associated requests under the same history lock; routes apply the same explorer-root guard to these payloads as to standalone request details. `shared/request-matches.js` requires exact request/message IDs, canonical file identity, normalized pre-edit snapshot equality, validated selection text/coordinates, and precise CodeMirror change boundaries inside the selection before placing a prompt. It includes a selected line's trailing newline for full-line deletions and omits guessed mappings through intervening edits. `history-diff.js` combines ordinary block-widget decorations with `unifiedMergeView`; deleted-only chunks use a widget ordered after the native deleted block and before the next surviving line. Reverts recompute annotations, and themes update without replacing the review.

The build also ships `assets/history-lock.mjs` and `assets/history-diff.mjs`, bundled Node helpers used by the backend, and `assets/history-licenses.txt` for the new bundled dependencies. Their dependencies must be bundled because repository-based plugin installation does not install npm packages. The lock bundle's `createRequire` banner supports CommonJS dependencies in native Node ESM; test the built helpers directly as well as through Vitest.

Batch internals retain the existing `review` API paths, storage directories, and DOM hooks for compatibility with saved requests.

Build assets are shipped with `extension.mjs`; regenerate them after frontend changes and do not edit them by hand. The host provides the Copilot SDK, so it is not an npm dependency.

`npm run build` clears the generated `assets/` directory before bundling so obsolete hash-named chunks do not accumulate. Keep these assets committed: repository-based plugin installation does not install npm dependencies or run a build. GitHub treats `assets/` as generated output and collapses it in pull request diffs.

Run `npm run build:check` to rebuild and reject any modified, deleted, staged, or untracked assets relative to the committed tree. CI runs this check in the required **Tests** job before running the test suite, so PRs must include current build output and remove stale chunks.

## Releases

We use [Changesets](https://changesets.dev/) to manage releases. Add a changeset when a change should be included in the next release; pull requests that do not require a release do not need one.

Run `npm run changeset`, select `vim-copilot-canvas`, choose a patch, minor, or major bump, and write a user-facing summary. Commit the generated `.changeset/*.md` file with the change.

On pushes to `main`, the **Release** workflow creates or updates a release PR, which applies pending changesets and updates the version files and changelog. Do not bump these versions independently. Release preparation also runs a clean frontend build; the Changesets action commits any updated assets and deleted stale chunks in the same release PR as the version metadata.

Changesets are optional for pull requests. Release metadata validation, asset checks, and tests still run for every PR and push to `main`.

Once the release PR passes **Tests**, merge it. The next release run creates a GitHub release. Rerun **Actions > Release** on `main` to retry an interrupted run.

Before publishing, `npm run release` rebuilds and verifies that committed assets match the result. If drift is detected at this stage, publishing stops rather than tagging stale files; regenerate and commit the assets through a PR before retrying.

`npm run release:check` verifies version consistency locally and in CI. `npm run version:release` is normally automation-owned; use it locally only to debug versioning, and inspect all generated changes before committing.

## Continuous integration and merging

GitHub Actions runs the **Tests** job on Ubuntu with Node.js 24 for pushes to `main` and pull requests. It installs dependencies and Chromium, builds, and runs `npm test`. Optional Windows coverage can be started from **Actions > Windows tests > Run workflow** on `main`.

The `main` ruleset requires pull requests, an up-to-date branch, and a passing **Tests** check. Repository settings control these rules.
