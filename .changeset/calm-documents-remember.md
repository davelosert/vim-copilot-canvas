---
"vim-copilot-canvas": minor
---

Add persistent per-file history for manual edits, observed external changes, and individual or batched requests sent to Copilot, with native inline diffs in the main editor area, guarded per-change or whole-entry reverts, exact request context, and navigation to surviving text. Link SDK-confirmed Copilot file writes to retained requests using exact message and turn IDs, without inferring authorship from timing. Group consecutive Vim edits into the latest entry and mark sent requests with the Copilot icon. Preserve cursor and reading position when external edits reload a document.

Distinguish sent requests from Copilot edits in a simplified timeline without prompt previews or turn links. Reopen requests in a read-only original-source view with prompts inline at their frozen selections, stacking batch selections and prompts in request order; clearly label selection-only context for older history. Store validated, deduplicated request-source snapshots locally without sending full source to Copilot. Show prompts beneath precisely matched changes using native CodeMirror diff widgets only when request/message evidence and the exact pre-edit source verify their placement.
