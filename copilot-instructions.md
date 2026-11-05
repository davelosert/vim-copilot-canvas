# Copilot instructions

- This is a GitHub App Copilot Canvas that brings Vim-style editing features to the GitHub Copilot App. Changes must remain compatible with the latest GitHub Copilot App. This will never be a standalone application.
- Run tests often and keep all tests passing. Treat tests as production-level artifacts: maintain them carefully and keep them decoupled.
- This project uses Changesets. For every user-facing change, create and commit a `.changeset/*.md` file with an appropriate version bump and changelog summary unless the user explicitly instructs otherwise. Documentation-only, test-only, and maintenance-only changes do not require a changeset.
