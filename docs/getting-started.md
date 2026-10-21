# Getting started

Install the plugin from this GitHub repository in the Copilot App:

1. In the app sidebar, click **Customize**, then **Plugins**.
2. Click the settings icon beside the marketplace dropdown and add `davelosert/vim-copilot-canvas` as a marketplace.
3. Find **Vim Copilot Canvas** in the plugin list and click **Install**.
4. Start a new session and ask Copilot to open **Vim Copilot Canvas** (`vim-markdown`). Use **Customize > Installed** to check that the plugin is installed and enabled.

Adding this repository as a project does not register its marketplace, and registering the marketplace does not install its plugin. **Customize > Canvas** is a curated list of featured canvases, not a list of every canvas available from custom marketplaces.

## CLI installation and troubleshooting

The same marketplace and plugin can be managed from the CLI:

```sh
copilot plugin marketplace add davelosert/vim-copilot-canvas
copilot plugin marketplace browse vim-copilot-canvas
copilot plugin install vim-copilot-canvas@vim-copilot-canvas
```

If the marketplace is already registered but its listing is missing or outdated, refresh its catalog:

```sh
copilot plugin marketplace update vim-copilot-canvas
copilot plugin marketplace list
copilot plugin marketplace browse vim-copilot-canvas
copilot plugin list
```

If an older plugin is already installed, run `copilot plugin update vim-copilot-canvas`. If it is disabled, run `copilot plugin enable vim-copilot-canvas`. Start a new app session after installing or updating the plugin.

The repository includes a marketplace catalog at `.github/plugin/marketplace.json`, a root `plugin.json`, and the production canvas entry at `com.github.copilot/extensions/vim-canvas/extension.mjs`. Installation uses committed files from GitHub, so local fixes must be published to the marketplace's branch before remote users can receive them.

See GitHub's guides to [customizing the Copilot App](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app), [working with canvas extensions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions), and [creating a plugin marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace) for details.
