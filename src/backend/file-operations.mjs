import { cp, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { EditorError } from "./errors.mjs";
import { writeNew } from "./files.mjs";

const inside = (path, parent) => path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);

async function assertMissing(path) {
    try {
        await lstat(path);
    } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    throw new EditorError("already_exists", `${basename(path)} already exists.`, 409);
}

/**
 * Explorer file operations, confined to the workspace root. Open documents follow
 * renames with their drafts; pending batch comments follow renames and are dropped
 * with deleted files.
 */
export function createFileOperations({ store, workspace, reviews }) {
    const remapReviews = (from, to) => reviews.update(workspace.root, (items) => items.map((item) => {
        if (!inside(item.path, from)) return item;
        const path = to + item.path.slice(from.length);
        return { ...item, path, attachments: item.attachments?.map((attachment) => ({ ...attachment, filePath: path })) };
    }));

    async function destination(source, to) {
        try {
            return await workspace.target(to);
        } catch (error) {
            // Case-only renames on case-insensitive file systems resolve to the source itself.
            if (error.code !== "already_exists" || source.type === "link") throw error;
            const absolute = resolve(workspace.root, to);
            if (await realpath(absolute) !== await realpath(source.path)) throw error;
            const target = `${await workspace.resolve(dirname(absolute))}${sep}${basename(absolute)}`;
            if (target === source.path) throw error;
            return target;
        }
    }

    function checkNesting(source, target, verb) {
        if (source.type === "directory" && inside(target, source.path)) {
            throw new EditorError("invalid_move", `A folder cannot be ${verb} into itself.`, 400);
        }
    }

    return {
        async create(path, type) {
            if (type !== "file" && type !== "directory") throw new EditorError("invalid_input", "Choose a file or folder.", 400);
            const target = await workspace.target(path);
            await mkdir(dirname(target), { recursive: true });
            if (type === "directory") await mkdir(target);
            else await writeNew(target, "");
            return { path: target, type };
        },

        async move(from, to) {
            const source = await workspace.entry(from);
            const target = await destination(source, to);
            checkNesting(source, target, "moved");
            const caseOnly = target.toLowerCase() === source.path.toLowerCase();
            await store.relocate(source.path, target, async () => {
                if (!caseOnly) await assertMissing(target);
                await mkdir(dirname(target), { recursive: true });
                await rename(source.path, target);
            });
            await remapReviews(source.path, target);
            return { from: source.path, path: target, type: source.type };
        },

        async copy(from, to) {
            const source = await workspace.entry(from);
            const target = await workspace.target(to);
            checkNesting(source, target, "copied");
            await mkdir(dirname(target), { recursive: true });
            await cp(source.path, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
            return { from: source.path, path: target, type: source.type };
        },

        async delete(path) {
            const source = await workspace.entry(path);
            await store.remove(source.path, () => rm(source.path, { recursive: true }));
            await reviews.update(workspace.root, (items) => items.filter((item) => !inside(item.path, source.path)));
            return { path: source.path, type: source.type };
        },
    };
}
