# Changesets

Run `npm run changeset` for a user-facing change, select `vim-copilot-canvas`,
choose a patch, minor, or major bump, and describe the change for the changelog.
Commit the generated Markdown file with the implementation.

Add a changeset only when the change should be included in a release. Documentation, tests, and maintenance-only changes that do not need a release can omit one. Use an empty changeset (`npm run changeset -- add --empty`) when you want a change included in a release without a changelog summary.
See the root README's release documentation for automation and repository setup.
