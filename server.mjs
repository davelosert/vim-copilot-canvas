import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { EditorError } from "./store.mjs";
import { ReviewStore, composeReview, summarize } from "./review.mjs";

const POST_ENDPOINTS = ["/api/draft", "/api/save", "/api/reload", "/api/open", "/api/agent",
    "/api/review/add", "/api/review/remove", "/api/review/send", "/api/review/clear"];

function buildAttachments(target, selections) {
    if (!Array.isArray(selections) || !selections.length || selections.length > 10000) {
        throw new EditorError("invalid_input", "Editor context is required.", 400);
    }
    const validPosition = (position) => position && Number.isSafeInteger(position.line) && position.line >= 0 &&
        Number.isSafeInteger(position.character) && position.character >= 0;
    return selections.map((selection) => {
        if (!selection || !validPosition(selection.start) || !validPosition(selection.end) ||
            typeof selection.text !== "string" || Buffer.byteLength(selection.text) > 2 * 1024 * 1024 ||
            selection.end.line < selection.start.line ||
            (selection.end.line === selection.start.line && selection.end.character < selection.start.character)) {
            throw new EditorError("invalid_input", "The editor selection is invalid.", 400);
        }
        const { start, end, text } = selection;
        const lastLine = end.line > start.line && end.character === 0 ? end.line : end.line + 1;
        return {
            type: "selection", filePath: target.path,
            displayName: `${basename(target.path)}:${start.line + 1}${lastLine === start.line + 1 ? "" : `-${lastLine}`}`,
            selection: { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } },
            text,
        };
    });
}

function validPrompt(prompt) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 32000) {
        throw new EditorError("invalid_input", "Provide a prompt of up to 32,000 characters.", 400);
    }
    return prompt.trim();
}

export async function startServer({ store, workspace, document, root, sendMessage, reviews = new ReviewStore(join(store.artifacts, "reviews")) }) {
    const state = { activePath: document.path };
    let sending = false;
    const deliver = async (message) => {
        if (!sendMessage) throw new EditorError("agent_unavailable", "The agent is not connected. Reopen the canvas in a Copilot session.", 503);
        if (sending) throw new EditorError("agent_busy", "A message is already being sent.", 409);
        sending = true;
        try { return await sendMessage({ ...message, mode: "immediate" }); }
        finally { sending = false; }
    };
    const review = async () => ({ items: summarize(await reviews.list(workspace.root)) });
    const load = async (path) => store.open(await workspace.resolve(path ?? state.activePath));
    const snapshot = async (doc) => ({ ...(await store.snapshot(doc)), activePath: state.activePath });
    const token = randomBytes(32).toString("hex");
    const assets = new Map([
        ["/", ["index.html", "text/html; charset=utf-8"]],
        ["/editor.js", ["assets/editor.js", "text/javascript; charset=utf-8"]],
        ["/editor.css", ["editor.css", "text/css; charset=utf-8"]],
    ]);
    let origin;
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "connect-src 'self'; img-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
        const json = (status, value) => {
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(value));
        };
        try {
            if (req.headers.host !== new URL(origin).host ||
                (req.headers.origin && req.headers.origin !== origin)) {
                return json(403, { error: "origin_rejected", message: "Cross-origin requests are not allowed." });
            }
            const url = new URL(req.url, origin);
            const asset = assets.get(url.pathname) ??
                (/^\/chunks\/[\w-]+\.js$/.test(url.pathname)
                    ? [`assets${url.pathname}`, "text/javascript; charset=utf-8"] : undefined);
            if (req.method === "GET" && asset) {
                const body = await readFile(join(root, asset[0]));
                res.writeHead(200, { "Content-Type": asset[1] });
                return res.end(body);
            }
            const supplied = Buffer.from(req.headers["x-editor-token"] ?? "");
            const expected = Buffer.from(token);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
                return json(403, { error: "unauthorized", message: "Editor authentication failed. Reopen the canvas." });
            }
            if (req.method === "GET" && url.pathname === "/api/document") {
                return json(200, await snapshot(await load(url.searchParams.get("path") ?? undefined)));
            }
            if (req.method === "GET" && url.pathname === "/api/tree") {
                return json(200, await workspace.list(url.searchParams.get("dir") ?? undefined));
            }
            if (req.method === "GET" && url.pathname === "/api/review") {
                return json(200, await review());
            }
            if (req.method !== "POST" || !POST_ENDPOINTS.includes(url.pathname)) {
                return json(404, { error: "not_found", message: "Unknown endpoint." });
            }
            if (req.headers["content-type"] !== "application/json") {
                return json(415, { error: "invalid_content_type", message: "Expected JSON." });
            }
            let body = "";
            for await (const chunk of req) {
                body += chunk;
                if (Buffer.byteLength(body) > 14 * 1024 * 1024) {
                    throw new EditorError("body_too_large", "The request is too large.", 413);
                }
            }
            let input;
            try { input = JSON.parse(body); }
            catch { throw new EditorError("invalid_json", "The request is not valid JSON.", 400); }
            if (!input || typeof input !== "object") {
                throw new EditorError("invalid_input", "Expected a JSON object.", 400);
            }
            if (url.pathname === "/api/review/remove") {
                if (!Array.isArray(input.ids) || !input.ids.every((id) => typeof id === "string")) {
                    throw new EditorError("invalid_input", "Review comment ids are required.", 400);
                }
                await reviews.remove(workspace.root, input.ids);
                return json(200, await review());
            }
            if (url.pathname === "/api/review/clear") {
                await reviews.update(workspace.root, () => []);
                return json(200, await review());
            }
            if (url.pathname === "/api/review/send") {
                const items = await reviews.list(workspace.root);
                if (!items.length) throw new EditorError("review_empty", "The review has no comments.", 400);
                const messageId = await deliver({
                    prompt: composeReview(items),
                    attachments: items.flatMap((item) => item.attachments),
                });
                await reviews.remove(workspace.root, items.map((item) => item.id));
                return json(200, { messageId, ...(await review()) });
            }
            if (typeof input.path !== "string") {
                throw new EditorError("invalid_input", "A document path is required.", 400);
            }
            const target = await load(input.path);
            if (url.pathname === "/api/agent" || url.pathname === "/api/review/add") {
                const prompt = validPrompt(input.prompt);
                const attachments = buildAttachments(target, input.selections);
                if (url.pathname === "/api/agent") return json(200, { messageId: await deliver({ prompt, attachments }) });
                const label = typeof input.label === "string" && input.label.length <= 300 ? input.label : attachments[0].displayName;
                await reviews.add(workspace.root, {
                    path: target.path, label, prompt, attachments,
                    selections: attachments.map(({ selection }) => selection),
                });
                return json(200, await review());
            }
            if (url.pathname === "/api/open") {
                state.activePath = target.path;
                return json(200, await snapshot(target));
            }
            if (typeof input.revision !== "string") {
                throw new EditorError("invalid_input", "A document revision is required.", 400);
            }
            const result = url.pathname === "/api/draft"
                ? await store.update(target, input.content, input.revision)
                : url.pathname === "/api/save"
                    ? await store.save(target, input.revision)
                    : await store.reload(target, input.revision, input.diskHash);
            json(200, { ...result, activePath: state.activePath });
        } catch (error) {
            json(error.status ?? 500, {
                error: error.code ?? "editor_error",
                message: error.message ?? "The editor request failed.",
            });
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    return {
        state, workspace,
        get document() { return store.open(state.activePath); },
        async openFile(path) {
            const target = await load(path);
            state.activePath = target.path;
            return target;
        },
        server, url: `${origin}/#${token}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeIdleConnections();
        }),
    };
}
