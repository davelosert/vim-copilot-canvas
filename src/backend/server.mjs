import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EditorError } from "./errors.mjs";
import { SettingsStore } from "./settings-store.mjs";
import { ReviewStore } from "./review-store.mjs";
import { createRoutes } from "./routes.mjs";

const MAX_BODY_BYTES = 14 * 1024 * 1024;
const CONTENT_SECURITY_POLICY =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

// URL path -> [installation-relative file, MIME type]. Only these files are served.
const ASSETS = new Map([
    ["/", ["public/index.html", "text/html; charset=utf-8"]],
    ["/editor.js", ["assets/editor.js", "text/javascript; charset=utf-8"]],
    ["/editor.css", ["public/editor.css", "text/css; charset=utf-8"]],
]);

function assetFor(pathname) {
    return ASSETS.get(pathname) ??
        (/^\/chunks\/[\w-]+\.js$/.test(pathname) ? [`assets${pathname}`, "text/javascript; charset=utf-8"] : undefined);
}

async function readJson(req) {
    let body = "";
    for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
            throw new EditorError("body_too_large", "The request is too large.", 413);
        }
    }
    try { return JSON.parse(body); }
    catch { throw new EditorError("invalid_json", "The request is not valid JSON.", 400); }
}

/**
 * Loopback HTTP transport: security headers, host/origin checks, static assets,
 * token authentication and JSON decoding. Application logic lives in `routes`.
 * @param {{ root: string, routes: { get: Map, post: Map } }} options root is the installation root.
 */
export async function listen({ root, routes }) {
    const token = randomBytes(32).toString("hex");
    let origin;
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
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
            const asset = assetFor(url.pathname);
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
            const getRoute = req.method === "GET" ? routes.get.get(url.pathname) : undefined;
            if (getRoute) return json(200, await getRoute(url.searchParams));
            const postRoute = req.method === "POST" ? routes.post.get(url.pathname) : undefined;
            if (!postRoute) return json(404, { error: "not_found", message: "Unknown endpoint." });
            if (req.headers["content-type"] !== "application/json") {
                return json(415, { error: "invalid_content_type", message: "Expected JSON." });
            }
            json(200, await postRoute(await readJson(req)));
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
        server, url: `${origin}/#${token}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeIdleConnections();
        }),
    };
}

/**
 * Start one editor panel server.
 * @param {object} options
 * @param {string} options.root Installation root containing public/ and assets/.
 */
export async function startServer({ store, workspace, document, root, sendMessage,
    reviews = new ReviewStore(join(store.artifacts, "reviews")), settings = new SettingsStore() }) {
    const routes = createRoutes({ store, workspace, document, reviews, settings, sendMessage });
    const transport = await listen({ root, routes });
    return {
        state: routes.state, workspace,
        get document() { return routes.document; },
        openFile: routes.openFile,
        server: transport.server, url: transport.url, close: transport.close,
    };
}
