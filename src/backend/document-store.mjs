import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorError } from "./errors.mjs";
import { MAX_BYTES, atomicWrite, diskText, writeNew } from "./files.mjs";
import { HistoryStore } from "./history-store.mjs";

export const DEFAULT_WELCOME_PATH = fileURLToPath(new URL("../../resources/welcome.md", import.meta.url));
const hash = (text) => createHash("sha256").update(text).digest("hex");

export class DocumentStore {
    constructor(artifacts, { welcomePath = DEFAULT_WELCOME_PATH, history = new HistoryStore(join(artifacts, "history")) } = {}) {
        this.artifacts = artifacts;
        this.welcomePath = welcomePath;
        this.documents = new Map();
        this.operations = Promise.resolve();
        this.history = history;
        this.moves = new Map();
        this.deleted = new Set();
    }

    async open(filePath) {
        return this.locked(null, () => this.openUnlocked(filePath));
    }

    async openUnlocked(filePath) {
        await mkdir(join(this.artifacts, "drafts"), { recursive: true, mode: 0o700 });
        if (!filePath) {
            filePath = join(this.artifacts, "welcome.md");
            try {
                await stat(filePath);
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
                const welcome = await readFile(this.welcomePath, "utf8");
                try {
                    await writeNew(filePath, welcome);
                } catch (failure) {
                    if (failure.code !== "EEXIST") throw failure;
                }
            }
        }
        if (!isAbsolute(filePath)) throw new EditorError("absolute_path_required", "Provide an absolute file path.", 400);
        const path = await realpath(filePath);
        // A file now exists here again, so it no longer redirects to a renamed or deleted document.
        this.moves.delete(path);
        this.deleted.delete(path);
        if (this.documents.has(path)) return this.documents.get(path);
        const baseContent = await diskText(path);
        const draftPath = join(this.artifacts, "drafts", `${hash(path)}.json`);
        let draft;
        try {
            draft = await this.readDraft(draftPath);
            if (draft.path !== path) throw new Error(`Invalid saved draft: ${draftPath}`);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        const document = {
            path, name: basename(path), draftPath,
            baseContent: draft ? draft.baseContent : baseContent,
            content: draft ? draft.content : baseContent,
            revision: draft?.revision ?? randomUUID(),
        };
        await this.history.observe(path, baseContent);
        if (draft && draft.content !== draft.baseContent) {
            await this.history.local(path, draft.baseContent, draft.content, draft.revision);
        }
        this.documents.set(path, document);
        return document;
    }

    locked(document, operation) {
        // Opening and path changes share the same queue as writes, including requests
        // already waiting under a document's former name.
        const result = this.operations.catch(() => {}).then(operation);
        this.operations = result;
        return result;
    }

    async readDraft(draftPath) {
        const draft = JSON.parse(await readFile(draftPath, "utf8"));
        if (typeof draft.path !== "string" || !isAbsolute(draft.path) ||
            basename(draftPath) !== `${hash(draft.path)}.json` || typeof draft.content !== "string" ||
            typeof draft.baseContent !== "string" || typeof draft.revision !== "string") {
            throw new Error(`Invalid saved draft: ${draftPath}`);
        }
        return draft;
    }

    /** Current path of a document that may have been renamed or moved through the explorer. */
    successor(path) {
        const seen = new Set();
        while (this.moves.has(path) && !seen.has(path)) {
            seen.add(path);
            path = this.moves.get(path);
        }
        return path;
    }

    isDeleted(path) { return this.deleted.has(path); }

    /**
     * Include lazy recovery records as well as cached documents in path operations.
     */
    async affecting(path, operation) {
        return this.locked(null, async () => {
            const inside = (candidate) => candidate === path || candidate.startsWith(path.endsWith(sep) ? path : path + sep);
            const documents = new Map([...this.documents].filter(([key]) => inside(key)));
            const directory = join(this.artifacts, "drafts");
            await mkdir(directory, { recursive: true, mode: 0o700 });
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
                const draftPath = join(directory, entry.name);
                const draft = await this.readDraft(draftPath);
                if (inside(draft.path) && !documents.has(draft.path)) {
                    documents.set(draft.path, { ...draft, name: basename(draft.path), draftPath });
                }
            }
            return operation([...documents.values()]);
        });
    }

    /** Move `from` to `to` with `rename`, carrying open documents and their drafts along. */
    async relocate(from, to, rename) {
        return this.affecting(from, async (documents) => {
            await rename();
            for (const document of documents) {
                const previous = { path: document.path, draftPath: document.draftPath };
                const path = to + document.path.slice(from.length);
                Object.assign(document, { path, name: basename(path), draftPath: join(this.artifacts, "drafts", `${hash(path)}.json`) });
                if (this.documents.delete(previous.path)) this.documents.set(path, document);
                this.moves.set(previous.path, path);
                this.moves.delete(path);
                this.deleted.delete(path);
                await this.persist(document);
                await rm(previous.draftPath, { force: true });
            }
        });
    }

    /** Delete `path` with `remove`, discarding open documents and drafts below it. */
    async remove(path, remove) {
        return this.affecting(path, async (documents) => {
            await remove();
            for (const document of documents) {
                this.documents.delete(document.path);
                this.moves.delete(document.path);
                this.deleted.add(document.path);
                await rm(document.draftPath, { force: true });
            }
        });
    }

    async persist(document) {
        await atomicWrite(document.draftPath, JSON.stringify({
            path: document.path, content: document.content,
            baseContent: document.baseContent, revision: document.revision,
        }));
    }

    async state(document, { adopt = true } = {}) {
        const disk = await diskText(document.path);
        await this.history.observe(document.path, disk);
        let conflict = hash(disk) !== hash(document.baseContent);
        if (adopt && conflict && document.content === document.baseContent) {
            document.content = disk;
            document.baseContent = disk;
            document.revision = randomUUID();
            await this.persist(document);
            conflict = false;
        }
        return {
            path: document.path, name: document.name,
            content: document.content, revision: document.revision,
            dirty: document.content !== document.baseContent, conflict,
            diskHash: hash(disk),
        };
    }

    async snapshot(document) {
        return this.locked(document, () => this.state(document));
    }

    checkRevision(document, revision) {
        if (revision !== document.revision) {
            throw new EditorError("draft_conflict", "This draft changed in another panel. Your local text is preserved; copy it before reloading.");
        }
    }

    async update(document, content, revision) {
        if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES) {
            throw new EditorError("invalid_content", "Text must be smaller than 2 MiB.", 400);
        }
        return this.locked(document, async () => {
            this.checkRevision(document, revision);
            const next = { ...document, content, revision: randomUUID() };
            await this.history.local(document.path, document.content, content, next.revision);
            await this.persist(next);
            Object.assign(document, next);
            return this.state(document);
        });
    }

    async save(document, revision) {
        return this.locked(document, async () => {
            this.checkRevision(document, revision);
            const disk = await diskText(document.path);
            await this.history.observe(document.path, disk);
            if (hash(disk) !== hash(document.baseContent)) {
                throw new EditorError("disk_conflict", "The file changed on disk. Save is blocked; copy your draft or reload the disk version.");
            }
            const info = await stat(document.path);
            await this.history.saving(document.path, document.content);
            await atomicWrite(document.path, document.content, info.mode & 0o777);
            await this.history.saved(document.path, document.content);
            document.baseContent = document.content;
            document.revision = randomUUID();
            await this.persist(document);
            // A save response must describe our write, not silently acknowledge an intervening external edit.
            return this.state(document, { adopt: false });
        });
    }

    async reload(document, revision, diskHash) {
        return this.locked(document, async () => {
            this.checkRevision(document, revision);
            const disk = await diskText(document.path);
            await this.history.observe(document.path, disk);
            if (hash(disk) !== diskHash) {
                throw new EditorError("disk_conflict", "The file changed again. Refresh its status before reloading.");
            }
            const next = { ...document, content: disk, baseContent: disk, revision: randomUUID() };
            await this.persist(next);
            Object.assign(document, next);
            return this.state(document);
        });
    }
}
