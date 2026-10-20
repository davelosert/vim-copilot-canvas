<img src="public/logo.svg" alt="Vim Copilot Canvas logo: a green V with a block cursor" width="80" height="80">

# Vim Copilot Canvas

A Canvas for the GitHub Copilot App that brings Vim-style navigation and editing to your workspace, with:

- Inline prompts to the Copilot App, with the option to group feedback or change requests before sending them.
- First-class GitHub-flavored Markdown support with live previews, built on [CodeMirror](https://codemirror.net/).
- Local image previews (including SVG), resolved relative to the Markdown file within the workspace, up to 5 MiB per image. External images are not fetched.
- Bidirectional scroll sync between the Markdown editor and preview, matching relative document progress.
- A Vim-tree-style file explorer for quickly navigating project files.
- Settings and theming, including relative line numbers.

## Installation

Install the plugin from this GitHub repository in the Copilot App:

1. In the app sidebar, click **Customize**, then **Plugins**.
2. Click the settings icon beside the marketplace dropdown and add `davelosert/vim-copilot-canvas` as a marketplace.
3. Find **Vim Copilot Canvas** in the plugin list and click **Install**.
4. Open **Customize > Canvas** and start a session with the canvas.

The repository includes a plugin manifest and marketplace catalog for this installation flow. See GitHub's guides to [customizing the Copilot App](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app) and [creating a plugin marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace) for details.

## Development

Use Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`. `npm test` builds the production bundle and runs all tests; `npm run build` rebuilds the shipped assets only.

| Command | Scope |
| --- | --- |
| `npm run test:unit` | Logic and editor state |
| `npm run test:integration` | Filesystem and HTTP behavior |
| `npm run test:browser` | UI components and app in Vitest Browser Mode |
| `npm run test:e2e` | Built app and HTTP pages |
| `npm run test:watch` | Interactive test mode |

### Development canvas

Repository sessions discover `.github/extensions/vim-canvas-dev/extension.mjs`, which registers **Vim Copilot Canvas (Dev)** (`vim-markdown-dev`). Open it to run the backend and serve assets from the current checkout.

Rebuild after frontend changes. Reload extensions after backend or provider changes. Dev drafts and reviews are stored separately per session; explicit file saves still update the files in the checkout.

### Releases

We use [Changesets](https://changesets.dev/) to manage releases. Every pull request with a user-facing change must include a changeset; documentation, tests, and maintenance-only changes may omit one.

Run `npm run changeset`, select `vim-copilot-canvas`, choose a patch, minor, or major bump, and write a user-facing summary. Commit the generated `.changeset/*.md` file with the change.

On pushes to `main`, the **Release** workflow creates or updates a release PR, which applies pending changesets and updates the version files and changelog. Do not bump these versions independently.

Once the release PR passes **Tests**, merge it. The next release run creates a GitHub release. Rerun **Actions > Release** on `main` to retry an interrupted run.

`npm run release:check` verifies version consistency locally and in CI. `npm run version:release` is normally automation-owned; use it locally only to debug versioning, and inspect all generated changes before committing.

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

The frontend uses vanilla DOM and ES modules; `app.js` composes features and `main.js` is the production entry. Inline Agent prompts and review actions use [Primer CSS](https://primer.style/css), not React; the locally served `primer.css` includes only needed primitives and theme tokens, without a global reset or runtime dependency. New Primer surfaces should use `primer-scope` and matching colour-mode attributes; theme updates must preserve the host's colour-mode attributes.

The document controller manages edits, serialized saves, file switching, reloads, polling, and conflicts independently of the UI. It reloads the open document when disk content changes, replacing unsynced edits, and temporarily makes the editor read-only during reload. Backend routes use persistent stores; shared modules must remain safe to import in both browser and Node.js environments. Dispose independently mounted apps after each test.

Use unit tests for logic, integration tests for filesystem and HTTP behavior, and Browser Mode for UI interactions. E2E tests exercise the built app. Dispose independently mounted apps after each test. Build assets are shipped with `extension.mjs`; regenerate them after frontend changes and do not edit them by hand. The host provides the Copilot SDK, so it is not an npm dependency.

### Continuous integration and merging

GitHub Actions runs the **Tests** job on Ubuntu with Node.js 24 for pushes to `main` and pull requests. It installs dependencies and Chromium, builds, and runs `npm test`. Optional Windows coverage can be started from **Actions > Windows tests > Run workflow** on `main`.

The `main` ruleset requires pull requests, an up-to-date branch, and a passing **Tests** check. Repository settings control these rules.
