# Changesets

Run `npm run changeset` for a user-facing change, select `vim-copilot-canvas`,
choose a patch, minor, or major bump, and describe the change for the changelog.
Commit the generated Markdown file with the implementation.

Documentation, tests, and maintenance-only changes require an empty changeset (`npm run changeset -- add --empty`). The automated release PR consumes changesets and is exempt from this requirement.
See the root README's release documentation for automation and repository setup.
