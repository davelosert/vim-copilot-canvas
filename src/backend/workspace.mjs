import { execFile } from "node:child_process";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { EditorError } from "./errors.mjs";
import { diskText } from "./files.mjs";

const MAX_ENTRIES = 2000;
export const MAX_FILES = 50000;
const FILES_TTL = 5000;
// File search excludes these in both Git listings and the fallback walker.
const skipForFiles = new Set([".git", "node_modules"]);

function git(cwd, args) {
    return new Promise((resolve, reject) => {
        execFile("git", ["-C", cwd, ...args], { maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
            (error, stdout) => error ? reject(error) : resolve(stdout));
    });
}
const nulSplit = (output) => output.split("\0").filter(Boolean);
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
        this.filesCache = null;
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

    /** Locate an existing entry without following a final symlink; the entry itself is the target. */
    async entry(path) {
        if (typeof path !== "string" || !path) throw new EditorError("invalid_path", "A path is required.", 400);
        const absolute = resolve(this.root, path);
        const protectedRoot = () => new EditorError("root_protected", "The explorer root cannot be changed.", 403);
        if (absolute === this.root) throw protectedRoot();
        const parent = await this.resolve(dirname(absolute));
        const entry = join(parent, basename(absolute));
        if (entry === this.root) throw protectedRoot();
        let info;
        try { info = await lstat(entry); }
        catch (error) {
            if (error.code === "ENOENT") throw new EditorError("not_found", `No such file or folder: ${path}`, 404);
            throw error;
        }
        return { path: entry, type: info.isDirectory() ? "directory" : info.isSymbolicLink() ? "link" : "file" };
    }

    /** Resolve a not-yet-existing path below the root, canonicalizing its nearest existing ancestor. */
    async target(path) {
        if (typeof path !== "string" || !path.trim()) throw new EditorError("invalid_path", "A name is required.", 400);
        const absolute = resolve(this.root, path);
        const missing = [];
        let ancestor = absolute;
        for (;;) {
            try {
                ancestor = await realpath(ancestor);
                break;
            } catch (error) {
                if ((error.code !== "ENOENT" && error.code !== "ENOTDIR") || dirname(ancestor) === ancestor) throw error;
                missing.unshift(basename(ancestor));
                ancestor = dirname(ancestor);
            }
        }
        if (!missing.length) throw new EditorError("already_exists", `${relative(this.root, absolute) || basename(absolute)} already exists.`, 409);
        const target = join(ancestor, ...missing);
        if (!this.contains(ancestor) || !this.contains(target)) {
            throw new EditorError("outside_root", "That path is outside the explorer root.", 403);
        }
        if (!(await stat(ancestor)).isDirectory()) throw new EditorError("not_a_directory", `${relative(this.root, ancestor)} is not a folder.`, 400);
        return target;
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

    /**
     * Every file below the root as root-relative, "/"-separated paths. Uses git (respecting
     * .gitignore) when the root is inside a repository and falls back to a bounded walker.
     */
    async files() {
        const now = Date.now();
        if (this.filesCache && now - this.filesCache.time < FILES_TTL) return this.filesCache.value;
        const pending = this.filesCache?.pending ?? (async () => {
            let files = await this.gitFiles().catch(() => null);
            if (files === null) files = await this.walkFiles();
            files = files.filter((path) => {
                const parts = path.split("/");
                return !this.ignore.has(parts[0]) && !parts.some((part) => skipForFiles.has(part));
            });
            const truncated = files.length > MAX_FILES;
            if (truncated) files = files.slice(0, MAX_FILES);
            files.sort((a, b) => a.localeCompare(b));
            return { root: this.root, separator: sep, files, truncated };
        })();
        this.filesCache = { ...this.filesCache, pending };
        try {
            const value = await pending;
            this.filesCache = { time: Date.now(), value };
            return value;
        } catch (error) {
            this.filesCache = null;
            throw error;
        }
    }

    invalidateFiles() { this.filesCache = null; }

    async gitFiles() {
        const [cached, untracked, deleted] = await Promise.all([
            git(this.root, ["ls-files", "-z", "--cached", "--stage"]),
            git(this.root, ["ls-files", "-z", "--others", "--exclude-standard"]),
            git(this.root, ["ls-files", "-z", "--deleted"]),
        ]);
        const removed = new Set(nulSplit(deleted));
        const tracked = nulSplit(cached)
            .filter((entry) => !entry.startsWith("160000 "))
            .map((entry) => entry.slice(entry.indexOf("\t") + 1));
        return [...new Set([...tracked, ...nulSplit(untracked)])].filter((path) => !removed.has(path));
    }

    async walkFiles() {
        const files = [];
        const queue = [""];
        while (queue.length && files.length <= MAX_FILES) {
            const prefix = queue.shift();
            let items;
            try { items = await readdir(join(this.root, prefix), { withFileTypes: true }); }
            catch { continue; }
            for (const item of items) {
                if (files.length > MAX_FILES) break;
                if (!prefix && this.ignore.has(item.name)) continue;
                if (skipForFiles.has(item.name)) continue;
                const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
                if (item.isDirectory()) queue.push(relativePath);
                else if (item.isFile()) files.push(relativePath);
                else if (item.isSymbolicLink()) {
                    // Like git, list symlinked files but never descend into symlinked directories (no cycles).
                    try {
                        const target = await realpath(join(this.root, relativePath));
                        if (this.contains(target) && (await stat(target)).isFile()) files.push(relativePath);
                    } catch { /* dangling link */ }
                }
            }
        }
        return files;
    }
}
