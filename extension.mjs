import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createProvider } from "./src/backend/canvas-provider.mjs";
import { observeAgentHistory } from "./src/backend/agent-history.mjs";

// Installation root: drafts, reviews, public assets and resources resolve from here.
const root = dirname(fileURLToPath(import.meta.url));

const provider = createProvider({
    root,
    sdk: { createCanvas, CanvasError },
    historyDir: join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"), "extensions", "vim-canvas", "artifacts", "history"),
    sendMessage: (message) => session.send(message),
});

const session = await joinSession({ canvases: [provider.canvas] });
observeAgentHistory(session, provider.store);
