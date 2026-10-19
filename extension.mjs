import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { DocumentStore } from "./store.mjs";
import { startServer } from "./server.mjs";
import { Workspace } from "./workspace.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const store = new DocumentStore(join(root, "artifacts"));
const servers = new Map();

function entry(ctx) {
    const value = servers.get(ctx.instanceId);
    if (!value) throw new CanvasError("editor_not_open", "Open this editor before invoking an action.");
    return value;
}

await joinSession({
    canvases: [createCanvas({
        id: "vim-markdown",
        displayName: "Vim Markdown",
        description: "Edit Markdown files with Vim keybindings, a Vim-navigable file explorer, live preview, and conflict-aware saves.",
        inputSchema: {
            type: "object",
            properties: {
                filePath: { type: "string", minLength: 1, description: "Absolute path of the file to open first." },
                rootPath: { type: "string", minLength: 1, description: "Absolute explorer root directory. Defaults to the file's Git repository or folder." },
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
                description: "List Markdown/text files and folders in an explorer directory (defaults to the root).",
                inputSchema: {
                    type: "object",
                    properties: { dir: { type: "string", minLength: 1 } },
                    additionalProperties: false,
                },
                handler: async (ctx) => entry(ctx).workspace.list(ctx.input?.dir),
            },
        ],
        open: async (ctx) => {
            const { filePath, rootPath } = ctx.input ?? {};
            const key = JSON.stringify([filePath ?? null, rootPath ?? null]);
            let value = servers.get(ctx.instanceId);
            if (value && value.key !== key) {
                servers.delete(ctx.instanceId);
                await value.close();
                value = undefined;
            }
            if (!value) {
                let workspace;
                let document;
                if (!filePath && !rootPath) {
                    document = await store.open();
                    workspace = new Workspace(dirname(document.path), { ignore: ["drafts"] });
                } else {
                    workspace = await Workspace.create({ rootPath, filePath });
                    document = await store.open(await workspace.resolve(filePath ?? await workspace.firstDocument()));
                }
                value = Object.assign(await startServer({ store, workspace, document, root }), { key });
                servers.set(ctx.instanceId, value);
            }
            return { title: `Vim · ${basename(value.workspace.root)}`, url: value.url };
        },
        onClose: async (ctx) => {
            const value = servers.get(ctx.instanceId);
            if (!value) return;
            servers.delete(ctx.instanceId);
            await value.close();
        },
    })],
});
