# Vim Copilot Canvas

A Canvas for the GitHub Copilot App that brings Vim-style navigation and editing
to your workspace, with:

- Inline prompts to the Copilot App, with the option to group feedback or change
  requests before sending them.
- First-class GitHub-flavored Markdown support with live previews, built on
  [CodeMirror](https://codemirror.net/).
- A Vim-tree-style file explorer for quickly navigating project files.
- Settings and theming, including relative line numbers.

Collect requests in a **batch** to send them to the agent together; this is not a GitHub pull request review.
Pending batch comments have clickable comment icons in the editor's left-hand gutter.
Click an icon (or **Edit** in the batch list) to reopen the comment inline, then choose **Save changes**, **Delete comment**, or **Cancel**.
Clicking a batch list item opens its file, jumps to its location, and expands the comment inline.
Each comment has its own icon, including when several comments refer to the same line.
For multi-line selections, the icon appears on the last selected line.
Click the same icon again to close the inline editor without saving changes.
Edits retain the original selection context; saved comments survive reloads until the batch is sent or discarded.
New prompts always use **Enter** to send immediately and **Cmd/Ctrl+Enter** to **Add to batch**.
While a batch is pending, a third **Send batch** action (**Cmd/Ctrl+Shift+Enter**) sends the entire batch, including the current prompt if nonempty.
The batch bar shows the number of pending requests and offers **Send batch** and **Discard batch**; `:AgentSend` and `:AgentDiscard` remain available.
Settings includes **Vim mode in Agent panel**, enabled by default and saved across sessions.
Disable it to use standard editing in prompts and batch comments, with a single **Esc** to close; the main editor stays in Vim mode.
Changing this setting applies to open panels without clearing their text.

## Installation

Install the plugin from this GitHub repository in the Copilot App:

1. In the app sidebar, click **Customize**, then **Plugins**.
2. Click the settings icon beside the marketplace dropdown and add
   `davelosert/vim-copilot-canvas` as a marketplace.
3. Find **Vim Copilot Canvas** in the plugin list and click **Install**.
4. Open **Customize > Canvas** and start a session with the canvas.

The repository includes a plugin manifest and marketplace catalog for this
installation flow. See GitHub's guides to
[customizing the Copilot App](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app)
and [creating a plugin marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace)
for details.

## Development

Development requires a Vitest-supported Node.js release:
`^22.12.0 || ^24.0.0 || >=26.0.0`.

`npm test` builds the production bundle before running all Vitest projects.
Use `npm run build` to rebuild the shipped assets without running tests.
Playwright supplies the Chromium driver for Vitest Browser Mode and the
production-page tests; there is no separate Playwright test runner.

| Command | Scope |
| --- | --- |
| `npm run test:unit` | Pure logic, document-controller interleavings, and EditorState selections |
| `npm run test:integration` | Real filesystem stores, workspace rules, and HTTP contracts |
| `npm run test:browser` | Components and the assembled app in Vitest Browser Mode |
| `npm run test:e2e` | Fresh production build and real HTTP-page tests |
| `npm run test:watch` | Interactive Vitest development mode |

### Opening the current checkout's canvas

Repository sessions discover `.github/extensions/vim-canvas-dev/extension.mjs`, which registers **Vim Copilot Canvas (Dev)** (`vim-markdown-dev`) alongside the installed canvas.
Ask Copilot to open that dev canvas to run the backend and serve the assets from the current worktree, rather than the installed version.

Run `npm run build` after frontend changes and ask Copilot to reload extensions (`extensions_reload`) after backend or provider changes, or when first adding the dev registration to an existing session.
Then open **Vim Copilot Canvas (Dev)**; without explicit file or root input it uses the session's working directory.

Dev drafts, pending batches, and the fallback welcome document live in a `vim-canvas-dev/` directory under session storage, outside the checkout.
They survive extension reloads within that session but are isolated from other sessions and the installed canvas.
Explicit file saves still update the files you are editing; global editor settings remain shared.

### Releases

Releases use [Changesets](https://changesets.dev/). This is a GitHub-distributed
plugin, not an npm package: `private: true` prevents npm publication. Before the
first release, package and plugin versions use a `0.0.0` baseline. The initial
major changeset prepares the first `1.0.0` release.

For a user-facing change, run `npm run changeset`, select `vim-copilot-canvas`,
choose a patch, minor, or major bump, and write a user-facing summary. Commit the
generated `.changeset/*.md` file with the change. Documentation, tests, and
maintenance-only changes may omit a changeset; CI validates existing changesets
but does not require one on every PR.

On pushes to `main`, the **Release** workflow creates or updates a
`chore: release plugin` PR. Its `npm run version:release` command consumes pending
changesets, generates `CHANGELOG.md`, and synchronizes `package.json`,
`package-lock.json`, `plugin.json`, and the marketplace catalog's plugin and
metadata versions. Do not bump these versions independently.

Merge that PR once its required **Tests** check passes. The next release run
uses `changeset publish` to tag the private package and the Changesets action
creates a `vX.Y.Z` GitHub release at the merged commit, using that version's
changelog entry as release notes. GitHub provides source archives containing the
already-committed production assets; the workflow does not publish to npm or
change how the Copilot App installs this repository. Existing releases are left
unchanged on reruns. **Actions > Release > Run workflow** on `main` can retry an
interrupted run. If a run pushed a tag but failed before creating its release,
create the missing GitHub release from that tag and its changelog entry manually;
Changesets skips versions that are already tagged.

#### One-time repository setup

1. Create and install a GitHub App on this repository with repository permissions
   **Contents: Read and write** and **Pull requests: Read and write**. It must be
   allowed to push the `changeset-release/main` branch and create PRs; no bypass
   of `main` protection is needed.
2. Under **Settings > Secrets and variables > Actions**, add the App's client ID
   as a repository **variable** named `RELEASE_APP_CLIENT_ID`.
3. Generate a private key for the App and store its complete PEM contents as a
   repository **secret** named `RELEASE_APP_PRIVATE_KEY`.

The workflow mints a short-lived installation token scoped to this repository,
with only Contents and Pull requests write permissions. The token action revokes
it when the job finishes. App-authenticated release-PR pushes trigger CI. GitHub's built-in
`GITHUB_TOKEN` does not trigger subsequent push/PR workflows, so using it to
create the PR would leave this repository's required **Tests** check missing.
The same token creates release tags and GitHub releases through the Changesets
action. The built-in token remains read-only; enabling Actions PR creation for
that token is not required. No npm credentials or personal access tokens are
required: Changesets tags private packages without publishing them to npm.

`npm run release:check` verifies version consistency locally and in CI.
`npm run version:release` is normally automation-owned; use it locally only to
debug versioning, and inspect all generated changes before committing.

### Source layout and ownership

```text
extension.mjs          SDK discovery entry and provider wiring
src/frontend/          Browser application and feature factories
src/backend/           HTTP transport, routes, delivery, and persistent stores
src/shared/            Browser/Node-safe theme catalog
public/                HTML shell and stylesheet
resources/             Bundled welcome document
assets/                Generated editor bundle, Primer CSS, and lazy language chunks
tests/                 unit, integration, browser, e2e, and fixture helpers
```

The frontend uses plain ES modules and vanilla DOM. `app.js` composes the
features; `main.js` is the production entry. Inline Agent prompts and batch
actions use [Primer CSS](https://primer.style/css), not React. `primer.css`
bundles only Primer's primitives, light/dark tokens, and buttons; no global
reset is included. Apply `primer-scope` and the matching colour-mode attributes
to new Primer surfaces. The scope bridges neutral colours to the selected
editor palette while keeping Primer's primary action colours. Theme updates
must not overwrite the host's colour-mode attributes.
The generated stylesheet is served locally as `/primer.css`, with no CDN
or runtime dependency installation.

The document controller owns the current snapshot, edit generations, serialized saves, file switching, reloads, polling, and draft conflicts. It silently reloads the open document when its disk content changes, replacing any unsynced edits. It has no DOM or CodeMirror dependency. The editor adapter owns CodeMirror state and configuration; preview, settings, batches, explorer, and inline agent prompts own their own UI and communicate through explicit callbacks. Application disposal removes listeners and timers and destroys editor views, so components can be mounted independently in tests.
Reloading temporarily makes the editor read-only to protect the replacement
from concurrent input. Errors in unrelated UI features no longer mark the
document as unsaved or conflicted.

Backend transport handles loopback serving and request protection before
dispatching to application routes. Persistent stores retain their individual
locking and write semantics. Shared modules must not import browser or Node-only
APIs. Keep the required `extension.mjs` at the installation root: source
relocation does not change draft/review artifact locations or global settings.
The project dev entry overrides draft/review storage with its session directory while reusing the same provider.
Batch internals retain the existing `review` API paths, storage directories, and DOM hooks for compatibility with saved requests.

Use unit tests for deterministic save/conflict races, integration tests for
filesystem and HTTP behavior, and Browser Mode for real keyboard, focus, DOM,
and component interactions. Production-page tests exercise built assets,
navigation, reloads, and cross-layer behavior that a mounted component cannot
prove. Each independently mounted app must be disposed after its test.

Build assets are shipped alongside `extension.mjs` and must be regenerated
after frontend changes; do not edit generated files manually. Reload extensions
after changing provider code.
`npm run build` clears the generated `assets/` directory before bundling so obsolete hash-named chunks do not accumulate.
Keep these assets committed: repository-based plugin installation does not install npm dependencies or run a build.
GitHub treats `assets/` as generated output and collapses it in pull request diffs.

The Copilot SDK is provided by the host's extension resolver, not installed as
an npm dependency. For host-level checks, use an isolated extension installation
and exercise open, `get_document`, `list_files`, `open_file`, `save`, and close.
Do not reload or replace a user's installed extension merely to run repository
tests.

### Continuous integration and merging

GitHub Actions runs the **Tests** job on Ubuntu with Node.js 24 for every push to
`main` and every pull request, regardless of target branch or changed files.
It installs locked dependencies with `npm ci`, installs Chromium and its system
dependencies with `npx playwright install --with-deps chromium`, builds the
frontend, and runs `npm test` (all Vitest unit, integration, browser-component,
and production-page projects).
Use the same browser installation command when reproducing CI on Linux.

Windows coverage is opt-in to limit runner costs. After the workflow is merged
into `main`, select **Actions > Windows tests > Run workflow** and choose `main`.
It runs the same build and all Vitest projects on `windows-latest` with Node.js 24
and only Chromium's headless shell (`npx playwright install --only-shell chromium`).
Both browser-component and production-page tests run headlessly.
It never runs on pushes or pull requests; manual dispatches for
other branches or tags skip the job without allocating a Windows runner.
This optional check is not required for merging.

The active `main` ruleset requires pull requests and a passing **Tests** check
from GitHub Actions, with the PR branch up to date before merging. No approving
review is required. Direct pushes, force pushes, and branch deletion are blocked.
Repository administrators, including the owner, can bypass requirements only
through a pull request; this intentionally allows admins to merge with failed
or missing tests, but does not permit direct pushes. These rules are configured
in GitHub repository settings, separately from the workflow file.
