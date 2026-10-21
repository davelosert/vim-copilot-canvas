<img src="public/logo.svg" alt="Vim Copilot Canvas logo: a green V with a block cursor" width="80" height="80">

# Vim Copilot Canvas

A [GitHub Copilot App canvas](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions) for navigating and editing workspace files **Vim-style** with the ability to **directly interact with your Copilot Agent**. It is built on [CodeMirror](https://codemirror.net/) and [@replit's codemirror-vim plugin](https://github.com/replit/codemirror-vim).

## Highlights

- **Targeted Agent Assistance:** Select one or more lines in a file and prompt Copilot inline to hand them to the Agent for changes or answers to your questions. You can also **batch changes** before sending them off to the agent. This allows you to make targeted edits with ease.
- **Markdown Support:** Markdown files come with a synchronized live preview rendering GitHub-flavored Markdown and section navigation, allowing you to read and edit Markdown files easily and quickly.
- **Vim-Based File Navigation:** Navigate the files in your repository Vim-style in the side pane, so you can easily navigate your entire project.
- **Direct File Editing:** Unlike traditional Vim, edits go directly to files instead of a separate buffer, so there is no need to save with `:w`.
- **Document History:** Review grouped Vim edits and external changes in native inline diffs directly in the main editor, with guarded per-change or whole-entry reverts. Distinguish SDK-confirmed Copilot writes from sent requests, and reopen requests with their original source and prompts inline. Jump to surviving text without losing your reading position when files change externally.
- **Theming & Settings:** Choose from all of CodeMirror's supported themes and choose different settings to individualize the experience.
- **Open Links:** Open links from the Markdown editor with **Cmd+click** on macOS or **Ctrl+click** on Windows/Linux. Ordinary clicks still position the cursor.

See the [feature guide](docs/features.md) for usage details, [get started](docs/getting-started.md), and the [development guide](docs/development.md) to contribute.

## Development

Use Node.js 26. Install dependencies and run the test suite:

```sh
npm ci
npm test
```

In a repository session, open **Vim Copilot Canvas (Dev)** (`vim-markdown-dev`) to run the app from the current checkout. For frontend changes, use **Reload canvas** in the dev toolbar to rebuild and refresh the panel. It preserves the current document draft; rebuild errors appear in the canvas so you can retry. Install dependencies with `npm ci` first. See the [development guide](docs/development.md) for more test commands, build details, and release instructions.

## Acknowledgments

A huge shoutout to [CodeMirror](https://codemirror.net/) and [Replit](https://github.com/replit/codemirror-vim) for their great libraries, which made creating this canvas a breeze.

Consider contributing to or supporting these projects!
