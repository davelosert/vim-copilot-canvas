import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = fileURLToPath(new URL("../assets/", import.meta.url));

await rm(assets, { recursive: true, force: true });
await build({
    absWorkingDir: root,
    entryPoints: ["src/frontend/main.js"],
    bundle: true,
    format: "esm",
    splitting: true,
    outdir: assets,
    entryNames: "editor",
    chunkNames: "chunks/[name]-[hash]",
    minify: true,
    logLevel: "info",
});
