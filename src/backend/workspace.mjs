import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { EditorError } from "./errors.mjs";
import { diskText } from "./files.mjs";

const MAX_ENTRIES = 2000;
// The explorer lists everything, but the initial document is never picked from these.
const skipForInitial = (name) => name.startsWith(".") || name === "node_modules";

async function exists(path) {
    try { await stat(path); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function repositoryRoot(directory) {
    const home = homedir();
    for (let current = directory; ; current = dirname(current)) {
        if (await exists(join(current, ".git"))) return current;
        if (current === home || dirname(current) === current) return directory;
    }
}

/**
 * Resolve the explorer root and first document for a canvas open request.
 * Explicit `filePath`/`rootPath` win; otherwise the session's working directory
 * is used. Returns null when nothing usable is available (caller falls back to
 * the bundled welcome document).
 */
export async function resolveInitialTarget({ filePath, rootPath, workingDirectory, ignore } = {}) {
    if (filePath || rootPath) {
        const workspace = await Workspace.create({ rootPath, filePath, ignore });
        return { workspace, path: await workspace.resolve(filePath ?? await workspace.firstDocument()) };
    }
    if (!workingDirectory || !isAbsolute(workingDirectory)) return null;
    try {
        const workspace = await Workspace.create({ rootPath: workingDirectory, ignore });
        return { workspace, path: await workspace.firstDocument() };
    } catch (error) {
        if (["no_documents", "not_a_directory"].includes(error.code) || ["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) return null;
        throw error;
    }
}

export class Workspace {
    constructor(root, { ignore = [] } = {}) {
        this.root = root;
        this.ignore = new Set(ignore);
    }

    static async create({ rootPath, filePath, ignore }) {
        for (const value of [rootPath, filePath]) {
            if (value !== undefined && !isAbsolute(value)) {
                throw new EditorError("absolute_path_required", "Provide absolute paths.", 400);
            }
        }
        let root;
        if (rootPath) {
            root = await realpath(rootPath);
            if (!(await stat(root)).isDirectory()) throw new EditorError("not_a_directory", "rootPath must be a directory.", 400);
        } else {
            root = await repositoryRoot(dirname(await realpath(filePath)));
        }
        return new Workspace(root, { ignore });
    }

    contains(path) {
        return path === this.root || path.startsWith(this.root.endsWith(sep) ? this.root : this.root + sep);
    }

    async resolve(path) {
        if (typeof path !== "string" || !path) throw new EditorError("invalid_path", "A path is required.", 400);
        let real;
        try {
            real = await realpath(isAbsolute(path) ? path : join(this.root, path));
        } catch (error) {
            if (error.code === "ENOENT") throw new EditorError("not_found", `No such file: ${path}`, 404);
            throw error;
        }
        if (!this.contains(real)) throw new EditorError("outside_root", "That path is outside the explorer root.", 403);
        return real;
    }

    async list(directory = this.root) {
        const path = await this.resolve(directory);
        if (!(await stat(path)).isDirectory()) throw new EditorError("not_a_directory", "Not a directory.", 400);
        const entries = [];
        for (const item of await readdir(path, { withFileTypes: true })) {
            if (path === this.root && this.ignore.has(item.name)) continue;
            const full = join(path, item.name);
            let type = item.isDirectory() ? "directory" : item.isFile() ? "file" : null;
            if (item.isSymbolicLink()) {
                try {
                    const target = await realpath(full);
                    if (!this.contains(target)) continue;
                    const info = await stat(target);
                    type = info.isDirectory() ? "directory" : info.isFile() ? "file" : null;
                } catch { continue; }
            }
            if (type === "directory" || type === "file") {
                entries.push({ name: item.name, path: full, type });
            }
            if (entries.length >= MAX_ENTRIES) break;
        }
        entries.sort((a, b) => (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) ||
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
        return { root: this.root, rootName: basename(this.root), path, relative: relative(this.root, path), entries };
    }

    async firstDocument() {
        const queue = [this.root];
        for (let depth = 0; queue.length && depth < 4; depth++) {
            const next = [];
            for (const directory of queue) {
                const entries = (await this.list(directory)).entries.filter((entry) => !skipForInitial(entry.name));
                const files = entries.filter((entry) => entry.type === "file");
                const preferred = files.find((entry) => /^(readme|index)\.(md|markdown)$/i.test(entry.name));
                const candidates = preferred ? [preferred, ...files.filter((entry) => entry !== preferred)] : files;
                for (const file of candidates) {
                    try {
                        await diskText(await this.resolve(file.path));
                        return file.path;
                    } catch (error) {
                        if (!["unsupported_file", "unsupported_encoding"].includes(error.code)) throw error;
                    }
                }
                next.push(...entries.filter((entry) => entry.type === "directory").map((entry) => entry.path));
            }
            queue.splice(0, queue.length, ...next.slice(0, 200));
        }
        throw new EditorError("no_documents", "No supported UTF-8 text files were found under rootPath.", 404);
    }
}
