# Vim Copilot Canvas

A Canvas for the GitHub Copilot App that brings Vim-style navigation and editing
to your workspace, with dedicated editing and live preview for GitHub-flavored
Markdown. The editor is built on [CodeMirror](https://codemirror.net/).

Open an inline prompt to send Copilot the selected text as context. Or collect
prompts across locations and send them together for coordinated changes, much
like a pull request review. Editor settings include themes and relative line
numbers.

## Development

Install dependencies, build, and run the test suite:

```sh
npm ci
npm run build
npm test
```
