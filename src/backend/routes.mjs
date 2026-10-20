import { EditorError } from "./errors.mjs";
import { composeReview, summarize } from "./review-store.mjs";
import { buildAttachments, createDelivery, validPrompt } from "./agent-delivery.mjs";

/**
 * Application routes for one editor panel. Owns the panel's active document
 * path and exposes the same open/current-document operations to HTTP and SDK
 * callers. Handlers return JSON bodies or throw EditorError.
 */
export function createRoutes({ store, workspace, document, reviews, settings, sendMessage }) {
    const state = { activePath: document.path };
    const deliver = createDelivery(sendMessage);
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
    ]);

    const post = new Map([
        ["/api/draft", revisionInput((target, input) => store.update(target, input.content, input.revision))],
        ["/api/save", revisionInput((target, input) => store.save(target, input.revision))],
        ["/api/reload", revisionInput((target, input) => store.reload(target, input.revision, input.diskHash))],
        ["/api/open", documentInput(async (target) => {
            state.activePath = target.path;
            return snapshot(target);
        })],
        ["/api/agent", selectionInput(async (_target, _input, prompt, attachments) =>
            ({ messageId: await deliver({ prompt, attachments }) }))],
        ["/api/settings", (input) => settings.update(input)],
        ["/api/review/add", selectionInput(async (target, input, prompt, attachments) => {
            const label = typeof input.label === "string" && input.label.length <= 300 ? input.label : attachments[0].displayName;
            await reviews.add(workspace.root, {
                path: target.path, label, prompt, attachments,
                selections: attachments.map(({ selection }) => selection),
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
        ["/api/review/send", objectInput(async () => {
            const items = await reviews.list(workspace.root);
            if (!items.length) throw new EditorError("review_empty", "The batch has no requests.", 400);
            const messageId = await deliver({
                prompt: composeReview(items),
                attachments: items.flatMap((item) => item.attachments),
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
