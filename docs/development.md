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
src/frontend/          Browser application and feature factories
src/backend/           HTTP transport, routes, delivery, and persistent stores
src/shared/             Browser/Node-safe theme catalog
public/                 HTML shell and stylesheet
resources/              Bundled welcome document
assets/                 Generated editor bundle, Primer CSS, and lazy language chunks
tests/                  unit, integration, browser, e2e, and fixture helpers
```

The frontend uses vanilla DOM and ES modules; `app.js` composes features and `main.js` is the production entry. Inline Agent prompts and batch actions use [Primer CSS](https://primer.style/css), not React; the locally served `primer.css` includes only needed primitives and theme tokens, without a global reset or runtime dependency. New Primer surfaces should use `primer-scope` and matching colour-mode attributes; theme updates must preserve the host's colour-mode attributes.

The document controller manages edits, serialized saves, file switching, reloads, polling, and conflicts independently of the UI. It reloads the open document when disk content changes, replacing unsynced edits, and temporarily makes the editor read-only during reload. Backend routes use persistent stores; shared modules must remain safe to import in both browser and Node.js environments. Dispose independently mounted apps after each test.

Batch internals retain the existing `review` API paths, storage directories, and DOM hooks for compatibility with saved requests.

Build assets are shipped with `extension.mjs`; regenerate them after frontend changes and do not edit them by hand. The host provides the Copilot SDK, so it is not an npm dependency.

`npm run build` clears the generated `assets/` directory before bundling so obsolete hash-named chunks do not accumulate. Keep these assets committed: repository-based plugin installation does not install npm dependencies or run a build. GitHub treats `assets/` as generated output and collapses it in pull request diffs.

Run `npm run build:check` to rebuild and reject any modified, deleted, staged, or untracked assets relative to the committed tree. CI runs this check in the required **Tests** job before running the test suite, so PRs must include current build output and remove stale chunks.

## Releases

We use [Changesets](https://changesets.dev/) to manage releases. Every pull request with a user-facing change must include a changeset; documentation, tests, and maintenance-only changes may omit one.

Run `npm run changeset`, select `vim-copilot-canvas`, choose a patch, minor, or major bump, and write a user-facing summary. Commit the generated `.changeset/*.md` file with the change.

On pushes to `main`, the **Release** workflow creates or updates a release PR, which applies pending changesets and updates the version files and changelog. Do not bump these versions independently. Release preparation also runs a clean frontend build; the Changesets action commits any updated assets and deleted stale chunks in the same release PR as the version metadata.

Once the release PR passes **Tests**, merge it. The next release run creates a GitHub release. Rerun **Actions > Release** on `main` to retry an interrupted run.

Before publishing, `npm run release` rebuilds and verifies that committed assets match the result. If drift is detected at this stage, publishing stops rather than tagging stale files; regenerate and commit the assets through a PR before retrying.

`npm run release:check` verifies version consistency locally and in CI. `npm run version:release` is normally automation-owned; use it locally only to debug versioning, and inspect all generated changes before committing.

## Continuous integration and merging

GitHub Actions runs the **Tests** job on Ubuntu with Node.js 24 for pushes to `main` and pull requests. It installs dependencies and Chromium, builds, and runs `npm test`. Optional Windows coverage can be started from **Actions > Windows tests > Run workflow** on `main`.

The `main` ruleset requires pull requests, an up-to-date branch, and a passing **Tests** check. Repository settings control these rules.
