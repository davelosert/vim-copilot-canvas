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

Use Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`.
`npm test` builds the production bundle and runs all tests; `npm run build`
rebuilds the shipped assets only.

| Command | Scope |
| --- | --- |
| `npm run test:unit` | Logic and editor state |
| `npm run test:integration` | Filesystem and HTTP behavior |
| `npm run test:browser` | UI components and app in Vitest Browser Mode |
| `npm run test:e2e` | Built app and HTTP pages |
| `npm run test:watch` | Interactive test mode |

### Development canvas

Repository sessions discover `.github/extensions/vim-canvas-dev/extension.mjs`,
which registers **Vim Copilot Canvas (Dev)** (`vim-markdown-dev`). Open it to
run the backend and serve assets from the current checkout.

Rebuild after frontend changes. Reload extensions after backend or provider
changes. Dev drafts and reviews are stored separately per session; explicit
file saves still update the files in the checkout.

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
assets/                Generated editor bundle and lazy language chunks
tests/                 unit, integration, browser, e2e, and fixture helpers
```

The frontend uses vanilla DOM and ES modules; `app.js` composes features and
`main.js` is the production entry. The document controller manages edits,
saves, reloads, and conflicts independently of the UI. Backend routes use
persistent stores; shared modules must remain safe to import in both browser and
Node.js environments.

Use unit tests for logic, integration tests for filesystem and HTTP behavior,
and Browser Mode for UI interactions. E2E tests exercise the built app. Dispose
independently mounted apps after each test. Build assets are shipped with
`extension.mjs`; regenerate them after frontend changes and do not edit them by
hand. The host provides the Copilot SDK, so it is not an npm dependency.

### Continuous integration and merging

GitHub Actions runs the **Tests** job on Ubuntu with Node.js 24 for pushes to
`main` and pull requests. It installs dependencies and Chromium, builds, and
runs `npm test`. Optional Windows coverage can be started from
**Actions > Windows tests > Run workflow** on `main`.

The `main` ruleset requires pull requests, an up-to-date branch, and a passing
**Tests** check. Repository settings control these rules.
