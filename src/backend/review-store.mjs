import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "./files.mjs";
import { EditorError } from "./errors.mjs";

const MAX_ITEMS = 200;

// Pending agent review comments, persisted per explorer root so they survive reloads.
export class ReviewStore {
    constructor(directory) {
        this.directory = directory;
        this.cache = new Map();
        this.queues = new Map();
    }

    file(root) {
        return join(this.directory, `${createHash("sha256").update(root).digest("hex")}.json`);
    }

    async read(root) {
        const path = this.file(root);
        if (!this.cache.has(path)) {
            let items = [];
            try {
                const value = JSON.parse(await readFile(path, "utf8"));
                if (value?.root === root && Array.isArray(value.items)) items = value.items;
            } catch (error) {
                if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
            }
            this.cache.set(path, items);
        }
        return this.cache.get(path);
    }

    // Serialize read-modify-write per root so concurrent requests cannot drop comments.
    update(root, change) {
        const path = this.file(root);
        const run = (this.queues.get(path) ?? Promise.resolve()).then(async () => {
            const items = await change([...(await this.read(root))]);
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            await atomicWrite(path, JSON.stringify({ root, items }, null, 2));
            this.cache.set(path, items);
            return items;
        });
        this.queues.set(path, run.catch(() => {}));
        return run;
    }

    list(root) { return this.read(root); }

    add(root, item) {
        return this.update(root, (items) => {
            if (items.length >= MAX_ITEMS) {
                const error = new Error(`A batch can hold at most ${MAX_ITEMS} requests. Send or discard it first.`);
                Object.assign(error, { code: "review_full", status: 409 });
                throw error;
            }
            return [...items, { id: randomUUID(), createdAt: new Date().toISOString(), ...item }];
        });
    }

    remove(root, ids) {
        const remove = new Set(ids);
        return this.update(root, (items) => items.filter((item) => !remove.has(item.id)));
    }

    edit(root, id, prompt) {
        return this.update(root, (items) => {
            const index = items.findIndex((item) => item.id === id);
            if (index < 0) throw new EditorError("review_not_found", "This batch comment no longer exists.", 404);
            items[index] = { ...items[index], prompt };
            return items;
        });
    }
}

export function summarize(items) {
    return items.map(({ id, path, label, prompt, selections }) => ({
        id, path, label, prompt,
        lines: selections.map(({ start, end }) => ({
            start: start.line + 1,
            end: end.line > start.line && end.character === 0 ? end.line : end.line + 1,
        })),
    }));
}

export function composeReview(items) {
    const comments = items.map((item, index) => {
        const body = item.prompt.split("\n").map((line) => `   ${line}`).join("\n");
        return `${index + 1}. ${item.label} (${item.path})\n${body}`;
    });
    return `Please address ${items.length === 1 ? "this" : "these"} ${items.length} batched request${items.length === 1 ? "" : "s"}. ` +
        `Each one refers to the attached file selection with the same label.\n\n${comments.join("\n\n")}`;
}
