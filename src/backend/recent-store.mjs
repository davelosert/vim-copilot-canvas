import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "./files.mjs";

export const MAX_RECENT = 50;

// Recently opened files (absolute paths, most recent first), persisted per explorer root.
// Always read from disk: every panel has its own store instance but shares the file.
export class RecentStore {
    constructor(directory) {
        this.directory = directory;
        this.queues = new Map();
    }

    file(root) {
        return join(this.directory, `${createHash("sha256").update(root).digest("hex")}.json`);
    }

    async list(root) {
        try {
            const value = JSON.parse(await readFile(this.file(root), "utf8"));
            if (value?.root === root && Array.isArray(value.items)) return value.items.filter((item) => typeof item === "string");
        } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        return [];
    }

    add(root, item) {
        const path = this.file(root);
        const run = (this.queues.get(path) ?? Promise.resolve()).then(async () => {
            const current = await this.list(root);
            if (current[0] === item) return current;
            const items = [item, ...current.filter((entry) => entry !== item)].slice(0, MAX_RECENT);
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            await atomicWrite(path, JSON.stringify({ root, items }, null, 2));
            return items;
        });
        this.queues.set(path, run.catch(() => {}));
        return run;
    }
}
