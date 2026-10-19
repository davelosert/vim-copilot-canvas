import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createProvider } from "./src/backend/canvas-provider.mjs";

// Installation root: drafts, reviews, public assets and resources resolve from here.
const root = dirname(fileURLToPath(import.meta.url));

const provider = createProvider({
    root,
    sdk: { createCanvas, CanvasError },
    sendMessage: (message) => session.send(message),
});

const session = await joinSession({ canvases: [provider.canvas] });
