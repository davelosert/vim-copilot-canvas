import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = fileURLToPath(new URL("../assets/", import.meta.url));

await rm(assets, { recursive: true, force: true });
await build({
    absWorkingDir: root,
    entryPoints: { editor: "src/frontend/main.js" },
    bundle: true,
    format: "esm",
    splitting: true,
    outdir: assets,
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    minify: true,
    logLevel: "info",
});
// Server-side Markdown renderer: installed plugins ship without node_modules, so it is bundled too.
await build({
    absWorkingDir: root,
    entryPoints: { "markdown-worker": "src/backend/markdown-worker.mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: join(assets, "server"),
    outExtension: { ".js": ".mjs" },
    minify: true,
    logLevel: "info",
});
