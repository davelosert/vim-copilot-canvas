import { EditorError } from "./errors.mjs";
import { composeReview, summarize } from "./review-store.mjs";
import { buildAttachments, createDelivery, validPrompt, requestContext } from "./agent-delivery.mjs";
import { readImage } from "./images.mjs";

/**
 * Application routes for one editor panel. Owns the panel's active document
 * path and exposes the same open/current-document operations to HTTP and SDK
 * callers. Handlers return JSON bodies or throw EditorError.
 */
export function createRoutes({ store, workspace, document, reviews, settings, sendMessage }) {
    const state = { activePath: document.path };
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
    const load = async (path) => store.open(await workspace.resolve(path ?? state.activePath));
    const snapshot = async (doc) => ({ ...(await store.snapshot(doc)), activePath: state.activePath });
    const openFile = async (path) => {
        const target = await load(path);
        state.activePath = target.path;
        return target;
    };

    const objectInput = (handler) => async (input) => {
        if (!input || typeof input !== "object") {
            throw new EditorError("invalid_input", "Expected a JSON object.", 400);
        }
        return handler(input);
    };
    const documentInput = (handler) => objectInput(async (input) => {
        if (typeof input.path !== "string") {
            throw new EditorError("invalid_input", "A document path is required.", 400);
        }
        return handler(await load(input.path), input);
    });
    const revisionInput = (operation) => documentInput(async (target, input) => {
        if (typeof input.revision !== "string") {
            throw new EditorError("invalid_input", "A document revision is required.", 400);
        }
        return { ...(await operation(target, input)), activePath: state.activePath };
    });
    const selectionInput = (handler) => documentInput((target, input) => {
        const prompt = validPrompt(input.prompt);
        return handler(target, input, prompt, buildAttachments(target, input.selections));
    });

    const get = new Map([
        ["/api/document", async (query) => snapshot(await load(query.get("path") ?? undefined))],
        ["/api/tree", (query) => workspace.list(query.get("dir") ?? undefined)],
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
        ["/api/image", documentInput((target, input) => readImage(workspace, target.path, input.source))],
        ["/api/draft", revisionInput((target, input) => store.update(target, input.content, input.revision))],
        ["/api/save", revisionInput((target, input) => store.save(target, input.revision))],
        ["/api/reload", revisionInput((target, input) => store.reload(target, input.revision, input.diskHash))],
        ["/api/open", documentInput(async (target) => {
            state.activePath = target.path;
            return snapshot(target);
        })],
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
        ["/api/review/clear", objectInput(async () => {
            await reviews.update(workspace.root, () => []);
            return review();
        })],
    ]);

    return {
        state, workspace, get, post, openFile,
        get document() { return store.open(state.activePath); },
    };
}
