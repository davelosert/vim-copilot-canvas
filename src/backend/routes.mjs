import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { EditorError } from "./errors.mjs";
import { createFileOperations } from "./file-operations.mjs";
import { composeReview, summarize } from "./review-store.mjs";
import { buildAttachments, createDelivery, validPrompt, requestContext } from "./agent-delivery.mjs";
import { readImage } from "./images.mjs";

/**
 * Application routes for one editor panel. Owns the panel's active document
 * path and exposes the same open/current-document operations to HTTP and SDK
 * callers. Handlers return JSON bodies or throw EditorError.
 */
export function createRoutes({ store, workspace, document, reviews, recents, settings, sendMessage, markdown }) {
    const state = { activePath: document.path };
    const activeAliases = new Set([document.path]);
    // Recents are a convenience: failing to record one never fails the open.
    const remember = (path) => recents?.add(workspace.root, path).catch(() => {});
    const initialized = workspace.contains(document.path) ? remember(document.path) : Promise.resolve();
    const files = async () => {
        const listing = await workspace.files();
        const known = new Set(listing.files);
        const recent = (await recents?.list(workspace.root).catch(() => []) ?? [])
            .map((path) => relative(workspace.root, path).split(sep).join("/"))
            .filter((path) => known.has(path));
        return { ...listing, recent };
    };
    const deliver = createDelivery(sendMessage);
    const sendRecorded = async ({ type, prompt, items, deliveryId }) => {
        for (const item of items) await load(item.path);
        const request = await store.history.prepare({ id: deliveryId, type, prompt, items });
        let messageId = request.messageId;
        if (request.status === "prepared" && !request.fresh) {
            throw new EditorError("delivery_uncertain", "This request may already have been sent. Check the conversation before sending again.", 409);
        }
        if (request.status !== "sent") {
            try {
                messageId = await deliver({ prompt, attachments: items.flatMap((item) => item.attachments) });
            } catch (error) {
                await store.history.failed(request.id);
                throw error;
            }
        }
        try { await store.history.delivered(request.id, messageId); }
        catch (error) {
            throw new EditorError("history_finalize_failed",
                `Sent to Copilot, but history could not be finalized: ${error.message}. Retry the same request to finalize without resending.`, 500);
        }
        return messageId;
    };
    const review = async () => ({ items: summarize(await reviews.list(workspace.root)) });
    const fileOperations = createFileOperations({ store, workspace, reviews });
    const activePath = () => {
        activeAliases.add(document.path);
        return (state.activePath = document.path);
    };
    const activate = (target) => {
        document = target;
        activeAliases.clear();
        activePath();
    };
    const load = async (path, { explicit = false } = {}) => {
        const requested = path ?? activePath();
        activePath();
        // Background requests belong to this panel's buffer, even if a former path
        // now names a different file. Explicit opens deliberately select that file.
        if (!explicit && activeAliases.has(resolve(workspace.root, requested))) {
            store.checkDocument(document);
            await workspace.resolve(document.path);
            return document;
        }
        try {
            return await store.open(await workspace.resolve(requested));
        } catch (error) {
            if (error.code !== "not_found" || !isAbsolute(requested)) throw error;
            const moved = store.successor(requested);
            if (moved !== requested) return load(moved, { explicit });
            if (store.isDeleted(requested)) throw new EditorError("file_deleted", `${basename(requested)} was deleted. Its text remains in this editor until you open another file.`, 410);
            throw error;
        }
    };
    const track = (target, snapshot) => {
        if (target === document) activeAliases.add(snapshot.path);
        return { ...snapshot, activePath: activePath() };
    };
    const snapshot = async (doc) => track(doc, await store.snapshot(doc));
    const openFile = async (path) => {
        const target = await load(path, { explicit: true });
        activate(target);
        await remember(target.path);
        return target;
    };

    const objectInput = (handler) => async (input) => {
        if (!input || typeof input !== "object") {
            throw new EditorError("invalid_input", "Expected a JSON object.", 400);
        }
        return handler(input);
    };
    const documentInput = (handler, options) => objectInput(async (input) => {
        if (typeof input.path !== "string") {
            throw new EditorError("invalid_input", "A document path is required.", 400);
        }
        return handler(await load(input.path, options), input);
    });
    const revisionInput = (operation) => documentInput(async (target, input) => {
        if (typeof input.revision !== "string") {
            throw new EditorError("invalid_input", "A document revision is required.", 400);
        }
        return track(target, await operation(target, input));
    });
    const selectionInput = (handler) => documentInput((target, input) => {
        const prompt = validPrompt(input.prompt);
        return handler(target, input, prompt, buildAttachments(target, input.selections));
    });

    const get = new Map([
        ["/api/document", async (query) => snapshot(await load(query.get("path") ?? undefined))],
        ["/api/tree", (query) => workspace.list(query.get("dir") ?? undefined)],
        ["/api/files", () => files()],
        ["/api/settings", () => settings.read()],
        ["/api/review", () => review()],
        ["/api/history", async (query) => {
            const target = await load(query.get("path") ?? undefined);
            await store.snapshot(target);
            return store.history.list(target.path);
        }],
        ["/api/history/entry", async (query) => {
            const target = await load(query.get("path") ?? undefined);
            const entry = await store.history.detail(target.path, query.get("id"));
            for (const request of entry.items ? [entry] : entry.requests ?? []) {
                for (const item of request.items) {
                    if (!workspace.contains(item.path)) {
                        throw new EditorError("outside_root", "This batch includes files outside the explorer root.", 403);
                    }
                }
            }
            return entry;
        }],
    ]);

    const post = new Map([
        ["/api/render", objectInput((input) => markdown.render(input.source))],
        ["/api/image", documentInput((target, input) => readImage(workspace, target.path, input.source))],
        ["/api/draft", revisionInput((target, input) => store.update(target, input.content, input.revision))],
        ["/api/save", revisionInput((target, input) => store.save(target, input.revision))],
        ["/api/reload", revisionInput((target, input) => store.reload(target, input.revision, input.diskHash))],
        ["/api/open", documentInput(async (target) => {
            activate(target);
            await remember(target.path);
            return snapshot(target);
        }, { explicit: true })],
        ["/api/agent", selectionInput(async (target, input, prompt, attachments) =>
            ({ messageId: await sendRecorded({ type: "request", prompt, deliveryId: input.deliveryId,
                items: [{ path: target.path, prompt, attachments, context: requestContext(input, attachments) }] }) }))],
        ["/api/settings", (input) => settings.update(input)],
        ["/api/review/add", selectionInput(async (target, input, prompt, attachments) => {
            const label = typeof input.label === "string" && input.label.length <= 300 ? input.label : attachments[0].displayName;
            await reviews.add(workspace.root, {
                path: target.path, label, prompt, attachments,
                selections: attachments.map(({ selection }) => selection), context: requestContext(input, attachments),
            });
            return review();
        })],
        ["/api/review/edit", objectInput(async (input) => {
            if (typeof input.id !== "string" || !input.id) {
                throw new EditorError("invalid_input", "A batch comment id is required.", 400);
            }
            await reviews.edit(workspace.root, input.id, validPrompt(input.prompt));
            return review();
        })],
        ["/api/review/remove", objectInput(async (input) => {
            if (!Array.isArray(input.ids) || !input.ids.every((id) => typeof id === "string")) {
                throw new EditorError("invalid_input", "Batch comment ids are required.", 400);
            }
            await reviews.remove(workspace.root, input.ids);
            return review();
        })],
        ["/api/review/send", objectInput(async (input) => {
            const items = await reviews.list(workspace.root);
            if (!items.length) throw new EditorError("review_empty", "The batch has no requests.", 400);
            const messageId = await sendRecorded({
                type: "batch", prompt: composeReview(items), deliveryId: input.deliveryId,
                items: items.map(({ path, prompt, label, attachments, id, context }) => ({ path, prompt, label, attachments, id, context })),
            });
            await reviews.remove(workspace.root, items.map((item) => item.id));
            return { messageId, ...(await review()) };
        })],
        ["/api/files/create", objectInput((input) => fileOperations.create(input.path, input.type))],
        ["/api/files/move", objectInput((input) => fileOperations.move(input.from, input.to))],
        ["/api/files/copy", objectInput((input) => fileOperations.copy(input.from, input.to))],
        ["/api/files/delete", objectInput(async (input) => {
            const result = await fileOperations.delete(input.path);
            const current = activePath();
            if (current !== result.path && !current.startsWith(`${result.path}${sep}`)) return result;
            let fallback = null;
            try { fallback = await workspace.firstDocument(); }
            catch (error) { if (error.code !== "no_documents") throw error; }
            return { ...result, fallback };
        })],
        ["/api/review/clear", objectInput(async () => {
            await reviews.update(workspace.root, () => []);
            return review();
        })],
    ]);

    return {
        state, workspace, get, post, openFile, initialized,
        get document() { return load(); },
    };
}
