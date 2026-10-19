import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const hash = (text) => createHash("sha256").update(text).digest("hex");

export class EditorError extends Error {
    constructor(code, message, status = 409) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

export async function atomicWrite(path, content, mode = 0o600) {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    let created = false;
    try {
        const handle = await open(temporary, "wx", mode);
        created = true;
        try {
            await handle.writeFile(content, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, path);
        created = false;
    } finally {
        if (created) await unlink(temporary);
    }
}

async function diskText(path) {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) {
        throw new EditorError("unsupported_file", "Choose a text file smaller than 2 MiB.", 400);
    }
    let content;
    try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    } catch (error) {
        if (error instanceof TypeError) throw new EditorError("unsupported_encoding", "This editor requires a UTF-8 text file.", 400);
        throw error;
    }
    if (content.includes("\0") || Buffer.byteLength(content) > MAX_BYTES) {
        throw new EditorError("unsupported_file", "This editor only supports text files smaller than 2 MiB.", 400);
    }
    return content;
}

export class DocumentStore {
    constructor(artifacts) {
        this.artifacts = artifacts;
        this.documents = new Map();
        this.locks = new Map();
    }

    async open(filePath) {
        await mkdir(join(this.artifacts, "drafts"), { recursive: true, mode: 0o700 });
        if (!filePath) {
            filePath = join(this.artifacts, "welcome.md");
            try {
                await stat(filePath);
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
                const welcome = await readFile(new URL("./welcome.md", import.meta.url), "utf8");
                try {
                    await writeNew(filePath, welcome);
                } catch (failure) {
                    if (failure.code !== "EEXIST") throw failure;
                }
            }
        }
        if (!isAbsolute(filePath)) throw new EditorError("absolute_path_required", "Provide an absolute file path.", 400);
        const path = await realpath(filePath);
        if (![".md", ".markdown", ".mdown", ".txt"].includes(extname(path).toLowerCase())) {
            throw new EditorError("unsupported_extension", "Open a .md, .markdown, .mdown, or .txt file.", 400);
        }
        return this.locked({ path }, async () => {
            if (this.documents.has(path)) return this.documents.get(path);
            const baseContent = await diskText(path);
            const draftPath = join(this.artifacts, "drafts", `${hash(path)}.json`);
            let draft;
            try {
                draft = JSON.parse(await readFile(draftPath, "utf8"));
                if (draft.path !== path || typeof draft.content !== "string" ||
                    typeof draft.baseContent !== "string" || typeof draft.revision !== "string") {
                    throw new Error(`Invalid saved draft: ${draftPath}`);
                }
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            const document = {
                path, name: basename(path), draftPath,
                baseContent: draft ? draft.baseContent : baseContent,
                content: draft ? draft.content : baseContent,
                revision: draft?.revision ?? randomUUID(),
            };
            this.documents.set(path, document);
            return document;
        });
    }

    async locked(document, operation) {
        const previous = this.locks.get(document.path) ?? Promise.resolve();
        const result = previous.catch(() => {}).then(operation);
        this.locks.set(document.path, result);
        try {
            return await result;
        } finally {
            if (this.locks.get(document.path) === result) this.locks.delete(document.path);
        }
    }

    async persist(document) {
        await atomicWrite(document.draftPath, JSON.stringify({
            path: document.path, content: document.content,
            baseContent: document.baseContent, revision: document.revision,
        }));
    }

    async state(document) {
        const disk = await diskText(document.path);
        let conflict = hash(disk) !== hash(document.baseContent);
        if (conflict && document.content === document.baseContent) {
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
            await this.persist(next);
            Object.assign(document, next);
            return this.state(document);
        });
    }

    async save(document, revision) {
        return this.locked(document, async () => {
            this.checkRevision(document, revision);
            const disk = await diskText(document.path);
            if (hash(disk) !== hash(document.baseContent)) {
                throw new EditorError("disk_conflict", "The file changed on disk. Save is blocked; copy your draft or reload the disk version.");
            }
            const info = await stat(document.path);
            await atomicWrite(document.path, document.content, info.mode & 0o777);
            document.baseContent = document.content;
            document.revision = randomUUID();
            await this.persist(document);
            return this.state(document);
        });
    }

    async reload(document, revision, diskHash) {
        return this.locked(document, async () => {
            this.checkRevision(document, revision);
            const disk = await diskText(document.path);
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

async function writeNew(path, content) {
    const handle = await open(path, "wx", 0o600);
    try {
        await handle.writeFile(content, "utf8");
    } finally {
        await handle.close();
    }
}
