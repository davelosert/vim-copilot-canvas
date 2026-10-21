import { Worker } from "node:worker_threads";
import { EditorError } from "./errors.mjs";

/**
 * Renders Markdown previews in a Node worker thread so large documents block neither the canvas
 * webview nor the extension's event loop. The thread starts lazily, is shared by every caller and
 * restarts after crashes. `script` is the bundled worker (assets/server/markdown-worker.mjs).
 */
export function createMarkdownService({ script }) {
    let worker, nextId = 0;
    const pending = new Map();
    const start = () => {
        const current = new Worker(script);
        current.unref();
        const stop = (message) => {
            if (worker !== current) return;
            worker = undefined;
            for (const request of pending.values()) request.reject(new EditorError("render_failed", message, 500));
            pending.clear();
        };
        current.on("message", ({ id, html, count, error }) => {
            const request = pending.get(id);
            if (!request) return;
            pending.delete(id);
            if (error) request.reject(new EditorError("render_failed", `Markdown rendering failed: ${error}`, 500));
            else request.resolve({ html, count });
        });
        current.on("error", (error) => stop(`Markdown renderer crashed: ${error.message}`));
        current.on("exit", () => stop("Markdown renderer stopped."));
        return current;
    };
    return {
        render(source) {
            if (typeof source !== "string") {
                return Promise.reject(new EditorError("invalid_input", "Markdown source is required.", 400));
            }
            worker ??= start();
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                worker.postMessage({ id, source });
            });
        },
        async close() {
            const current = worker;
            await current?.terminate();
        },
    };
}
