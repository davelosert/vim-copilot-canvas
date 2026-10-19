# Vim Copilot Canvas

A Canvas for the GitHub Copilot App that brings Vim-style navigation and editing
to your workspace, with:

- Inline prompts to the Copilot App, with the option to group feedback or change
  requests before sending them.
- First-class GitHub-flavored Markdown support with live previews, built on
  [CodeMirror](https://codemirror.net/).
- A Vim-tree-style file explorer for quickly navigating project files.
- Settings and theming, including relative line numbers.

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

### Source layout and ownership

```text
extension.mjs          SDK discovery entry and provider wiring
src/frontend/          Browser application and feature factories
src/backend/           HTTP transport, routes, delivery, and persistent stores
src/shared/            Browser/Node-safe theme catalog
public/                HTML shell and stylesheet
resources/             Bundled welcome document
assets/                Generated editor bundle and lazy language chunks
tests/                 unit, integration, browser, e2e, and fixture helpers
```

The frontend uses plain ES modules and vanilla DOM. `app.js` composes the
features; `main.js` is the production entry. The document controller owns the
current snapshot, edit generations, serialized saves, file switching, reloads,
polling, and conflicts. It has no DOM or CodeMirror dependency. The editor
adapter owns CodeMirror state and configuration; preview, settings, reviews,
explorer, and inline agent prompts own their own UI and communicate through
explicit callbacks. Application disposal removes listeners and timers and
destroys editor views, so components can be mounted independently in tests.
Reloading temporarily makes the editor read-only to protect the replacement
from concurrent input. Errors in unrelated UI features no longer mark the
document as unsaved or conflicted.

Backend transport handles loopback serving and request protection before
dispatching to application routes. Persistent stores retain their individual
locking and write semantics. Shared modules must not import browser or Node-only
APIs. Keep the required `extension.mjs` at the installation root: source
relocation does not change draft/review artifact locations or global settings.

Use unit tests for deterministic save/conflict races, integration tests for
filesystem and HTTP behavior, and Browser Mode for real keyboard, focus, DOM,
and component interactions. Production-page tests exercise built assets,
navigation, reloads, and cross-layer behavior that a mounted component cannot
prove. Each independently mounted app must be disposed after its test.

Build assets are shipped alongside `extension.mjs` and must be regenerated
after frontend changes; do not edit generated files manually. Reload extensions
after changing provider code.

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
