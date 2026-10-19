import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EditorError } from "./store.mjs";

export async function startServer({ store, workspace, document, root }) {
    const state = { activePath: document.path };
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
            if (req.method !== "POST" || !["/api/draft", "/api/save", "/api/reload", "/api/open"].includes(url.pathname)) {
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
            if (!input || typeof input !== "object" || typeof input.path !== "string") {
                throw new EditorError("invalid_input", "A document path is required.", 400);
            }
            const target = await load(input.path);
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
