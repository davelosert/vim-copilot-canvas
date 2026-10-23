import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createProvider, createVimCanvas } from "../../../src/backend/canvas-provider.mjs";
import { observeAgentHistory } from "../../../src/backend/agent-history.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const identity = { canvasId: "vim-markdown-dev", displayName: "Vim Copilot Canvas (Dev)" };
const sdk = { createCanvas: (definition) => definition, CanvasError };
let provider;
let rebuilding;

function devReload() {
    // The extension host's process.execPath can be the bundled Copilot executable, not Node.
    return rebuilding ??= promisify(execFile)("node", [join(root, "scripts/build.mjs")], { cwd: root })
        .then(() => ({}))
        .catch((error) => {
            if (error.code === "ENOENT") {
                throw new CanvasError("dev_node_unavailable", "Reload canvas requires Node.js on the app's PATH. Install a supported Node.js version and restart the app.");
            }
            throw error;
        })
        .finally(() => { rebuilding = undefined; });
}

async function getProvider() {
    const session = await sessionReady;
    if (!session.workspacePath) {
        throw new CanvasError("dev_storage_unavailable", "The dev canvas requires session workspace storage.");
    }
    if (provider) return provider;
    provider = createProvider({
        root, sdk, ...identity, devReload,
        artifactsDir: join(session.workspacePath, "vim-canvas-dev"),
        historyDir: join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"), "extensions", "vim-canvas-dev", "artifacts", "history"),
        sendMessage: (message) => session.send(message),
    });
    observeAgentHistory(session, provider.store);
    return provider;
}

// Declare the shared schema now; bind its handlers once session storage is available.
const definition = createVimCanvas({ ...sdk, ...identity });
const canvas = createCanvas({
    ...definition,
    open: async (ctx) => (await getProvider()).canvas.open(ctx),
    onClose: async (ctx) => (await getProvider()).canvas.onClose(ctx),
    actions: definition.actions.map((action) => ({
        ...action,
        handler: async (ctx) => {
            const { canvas } = await getProvider();
            return canvas.actions.find(({ name }) => name === action.name).handler(ctx);
        },
    })),
});
const sessionReady = joinSession({ canvases: [canvas] });
await sessionReady;
