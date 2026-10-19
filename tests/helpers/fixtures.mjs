import { mkdtemp, realpath, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import { DocumentStore } from "../../src/backend/document-store.mjs";
import { startServer } from "../../src/backend/server.mjs";
import { SettingsStore } from "../../src/backend/settings-store.mjs";
import { Workspace } from "../../src/backend/workspace.mjs";

/** Installation root: the directory containing extension.mjs, public/, resources/ and assets/. */
export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const welcomePath = join(repoRoot, "resources", "welcome.md");

/**
 * Create a canonical (realpath) temporary directory removed when the current test finishes.
 * Must be called from inside a running test.
 */
export async function tempDir(prefix = "vim-canvas-test-") {
    const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    return root;
}

/** Write a map of relative paths to contents (strings or Buffers) below root. */
export async function writeFiles(root, files) {
    await Promise.all(Object.entries(files).map(async ([name, content]) => {
        const path = join(root, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
    }));
}

/**
 * Temporary directory with one opened document and a DocumentStore whose artifacts live in the
 * same temporary directory (never in the installed extension).
 */
export async function documentFixture({ content = "# Original\n", name = "note.md", prefix, artifacts: artifactsName = "artifacts" } = {}) {
    const root = await tempDir(prefix);
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    const artifacts = join(root, artifactsName);
    const store = new DocumentStore(artifacts);
    const document = await store.open(path);
    return { root, path, artifacts, store, document };
}

/** Temporary SettingsStore; never the user-global COPILOT_HOME settings. */
export function temporarySettings(root, ...segments) {
    return new SettingsStore(join(root, ...(segments.length ? segments : ["settings.json"])));
}

/**
 * Start an editor server closed when the current test finishes. `settings` defaults to a temporary
 * store under `settingsRoot` (or the workspace root) and `root` to the installation root.
 */
export async function startEditorServer({ settings, settingsRoot, workspace, ...options }) {
    const entry = await startServer({
        root: repoRoot,
        workspace,
        settings: settings ?? temporarySettings(settingsRoot ?? workspace.root),
        ...options,
    });
    onTestFinished(() => entry.close());
    return entry;
}

/** Authenticated fetch helpers for an editor server entry. */
export function apiClient(entry) {
    const url = new URL(entry.url);
    const token = url.hash.slice(1);
    const call = (path, body, headers = {}) => fetch(new URL(`/api/${path}`, url), body === undefined
        ? { headers: { "X-Editor-Token": token, ...headers } }
        : {
            method: "POST",
            headers: { "X-Editor-Token": token, "Content-Type": "application/json", ...headers },
            body: typeof body === "string" ? body : JSON.stringify(body),
        });
    return { url, token, call };
}

/** Workspace tree with hidden, ignored, nested, natural-sort and escaping-symlink entries. */
export async function workspaceTree() {
    const base = await tempDir("vim-markdown-ws-");
    const rootDir = join(base, "notes");
    await mkdir(join(rootDir, "deep", "deeper"), { recursive: true });
    await mkdir(join(rootDir, "node_modules"), { recursive: true });
    await writeFile(join(rootDir, "README.md"), "# Root\n");
    await writeFile(join(rootDir, "b10.md"), "b10");
    await writeFile(join(rootDir, "b2.md"), "b2");
    await writeFile(join(rootDir, "script.js"), "x");
    await writeFile(join(rootDir, ".hidden.md"), "x");
    await writeFile(join(rootDir, "deep", "child.md"), "# Child\n");
    await writeFile(join(base, "outside.md"), "secret");
    await symlink(join(base, "outside.md"), join(rootDir, "escape.md"));
    return { base, rootDir, workspace: await Workspace.create({ rootPath: rootDir }) };
}

export { DocumentStore, SettingsStore, Workspace, startServer };
