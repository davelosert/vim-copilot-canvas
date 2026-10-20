import { basename, dirname, join } from "node:path";
import { DocumentStore } from "./document-store.mjs";
import { startServer as defaultStartServer } from "./server.mjs";
import { Workspace, resolveInitialTarget } from "./workspace.mjs";

export const CANVAS_ID = "vim-markdown";

/**
 * Installation-relative resources with an optional external persistence root.
 * @param {string} root Installation root (the directory containing extension.mjs).
 * @param {string} [artifactsDir] Defaults to the installation artifacts directory.
 */
export function installationPaths(root, artifactsDir = join(root, "artifacts")) {
    return {
        root,
        artifacts: artifactsDir,
        welcome: join(root, "resources", "welcome.md"),
    };
}

/**
 * Per-canvas-instance panel lifecycle, independent of the Copilot SDK.
 * @param {object} options
 * @param {DocumentStore} options.store Shared document store for all panels.
 * @param {string} options.root Installation root passed to the HTTP server.
 * @param {(message: object) => Promise<string>} [options.sendMessage]
 * @param {typeof defaultStartServer} [options.startServer]
 */
export function createPanels({ store, root, sendMessage, startServer = defaultStartServer }) {
    const servers = new Map();
    return {
        get(instanceId) { return servers.get(instanceId); },
        get size() { return servers.size; },
        async open({ instanceId, input, workingDirectory: sessionDirectory }) {
            const { filePath, rootPath } = input ?? {};
            const workingDirectory = filePath || rootPath ? null : sessionDirectory ?? null;
            const key = JSON.stringify([filePath ?? null, rootPath ?? null, workingDirectory]);
            let value = servers.get(instanceId);
            if (value && value.key !== key) {
                servers.delete(instanceId);
                await value.close();
                value = undefined;
            }
            if (!value) {
                let workspace;
                let document;
                const target = await resolveInitialTarget({ filePath, rootPath, workingDirectory });
                if (target) {
                    workspace = target.workspace;
                    document = await store.open(target.path);
                } else {
                    document = await store.open();
                    workspace = new Workspace(dirname(document.path), { ignore: ["drafts"] });
                }
                value = Object.assign(await startServer({ store, workspace, document, root, sendMessage }), { key });
                servers.set(instanceId, value);
            }
            return { title: `Vim · ${basename(value.workspace.root)}`, url: value.url };
        },
        async close(instanceId) {
            const value = servers.get(instanceId);
            if (!value) return;
            servers.delete(instanceId);
            await value.close();
        },
        async closeAll() {
            await Promise.all([...servers.keys()].map((id) => this.close(id)));
        },
    };
}

/**
 * Build the canvas registration using injected SDK factories, so the wiring
 * can be exercised without importing `@github/copilot-sdk/extension`.
 * @param {object} options
 * @param {(definition: object) => unknown} options.createCanvas
 * @param {new (code: string, message: string) => Error} options.CanvasError
 * @param {DocumentStore} options.store
 * @param {ReturnType<typeof createPanels>} options.panels
 * @param {string} [options.canvasId]
 * @param {string} [options.displayName]
 */
export function createVimCanvas({ createCanvas, CanvasError, store, panels,
    canvasId = CANVAS_ID, displayName = "Vim Copilot Canvas" }) {
    const entry = (ctx) => {
        const value = panels.get(ctx.instanceId);
        if (!value) throw new CanvasError("editor_not_open", "Open this editor before invoking an action.");
        return value;
    };
    return createCanvas({
        id: canvasId,
        displayName,
        description: "Edit UTF-8 text files with Vim keybindings, syntax highlighting, a file explorer, conflict-aware saves, and a live preview for Markdown.",
        inputSchema: {
            type: "object",
            properties: {
                filePath: { type: "string", minLength: 1, description: "Absolute path of the file to open first." },
                rootPath: { type: "string", minLength: 1, description: "Absolute explorer root directory. Defaults to the file's Git repository or folder, or to the session's working directory when no filePath is given." },
            },
            additionalProperties: false,
        },
        actions: [
            {
                name: "get_document",
                description: "Read the current file, unsaved draft, revision, and external-change status.",
                handler: async (ctx) => store.snapshot(await entry(ctx).document),
            },
            {
                name: "save",
                description: "Save the current persisted draft; refuses to overwrite externally changed files.",
                inputSchema: {
                    type: "object",
                    properties: { revision: { type: "string" } },
                    required: ["revision"],
                    additionalProperties: false,
                },
                handler: async (ctx) => store.save(await entry(ctx).document, ctx.input.revision),
            },
            {
                name: "open_file",
                description: "Switch the editor to another file inside the explorer root (absolute or root-relative path). Unsaved drafts are kept.",
                inputSchema: {
                    type: "object",
                    properties: { path: { type: "string", minLength: 1 } },
                    required: ["path"],
                    additionalProperties: false,
                },
                handler: async (ctx) => store.snapshot(await entry(ctx).openFile(ctx.input.path)),
            },
            {
                name: "list_files",
                description: "List files and folders in an explorer directory (defaults to the root). Binary files are listed but cannot be edited.",
                inputSchema: {
                    type: "object",
                    properties: { dir: { type: "string", minLength: 1 } },
                    additionalProperties: false,
                },
                handler: async (ctx) => entry(ctx).workspace.list(ctx.input?.dir),
            },
        ],
        open: (ctx) => panels.open({ instanceId: ctx.instanceId, input: ctx.input, workingDirectory: ctx.session?.workingDirectory }),
        onClose: (ctx) => panels.close(ctx.instanceId),
    });
}

/**
 * Compose the provider for an installation root.
 * @param {object} options
 * @param {string} options.root Installation root.
 * @param {{ createCanvas: Function, CanvasError: Function }} options.sdk
 * @param {(message: object) => Promise<string>} [options.sendMessage]
 * @param {string} [options.canvasId]
 * @param {string} [options.displayName]
 * @param {string} [options.artifactsDir] External draft/review storage directory.
 */
export function createProvider({ root, sdk, sendMessage, startServer, canvasId, displayName, artifactsDir }) {
    const paths = installationPaths(root, artifactsDir);
    const store = new DocumentStore(paths.artifacts, { welcomePath: paths.welcome });
    const panels = createPanels({ store, root, sendMessage, startServer });
    const canvas = createVimCanvas({ createCanvas: sdk.createCanvas, CanvasError: sdk.CanvasError, store, panels, canvasId, displayName });
    return { paths, store, panels, canvas };
}
