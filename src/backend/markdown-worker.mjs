import { parentPort } from "node:worker_threads";
import { renderMarkdown, wordCount } from "../frontend/markdown.js";

parentPort.on("message", ({ id, source }) => {
    try {
        parentPort.postMessage({ id, html: renderMarkdown(source), count: wordCount(source) });
    } catch (error) {
        parentPort.postMessage({ id, error: error.message });
    }
});
