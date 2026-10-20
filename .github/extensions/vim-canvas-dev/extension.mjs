import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createProvider, createVimCanvas } from "../../../src/backend/canvas-provider.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const identity = { canvasId: "vim-markdown-dev", displayName: "Vim Copilot Canvas (Dev)" };
const sdk = { createCanvas: (definition) => definition, CanvasError };
let provider;
let rebuilding;

function devReload() {
    return rebuilding ??= promisify(execFile)(process.execPath, [join(root, "scripts/build.mjs")], { cwd: root })
        .then(() => ({}))
        .finally(() => { rebuilding = undefined; });
}

async function getProvider() {
    const session = await sessionReady;
    if (!session.workspacePath) {
        throw new CanvasError("dev_storage_unavailable", "The dev canvas requires session workspace storage.");
    }
    return provider ??= createProvider({
        root, sdk, ...identity, devReload,
        artifactsDir: join(session.workspacePath, "vim-canvas-dev"),
        sendMessage: (message) => session.send(message),
    });
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
