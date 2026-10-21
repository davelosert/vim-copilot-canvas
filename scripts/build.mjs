import { rm, readFile, writeFile } from "node:fs/promises";
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
await build({
    absWorkingDir: root,
    entryPoints: ["src/shared/history-diff.js"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: `${assets}history-diff.mjs`,
    minify: true,
    logLevel: "info",
});
await build({
    absWorkingDir: root,
    entryPoints: ["src/backend/history-lock.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: `${assets}history-lock.mjs`,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    minify: true,
    logLevel: "info",
});
const historyLicenses = [
    ["@codemirror/merge", "LICENSE"], ["proper-lockfile", "LICENSE"], ["graceful-fs", "LICENSE"],
    ["retry", "License"], ["signal-exit", "LICENSE.txt"],
];
const notices = await Promise.all(historyLicenses.map(async ([name, license]) =>
    `${name}\n${await readFile(`${root}node_modules/${name}/${license}`, "utf8")}`));
notices.push(`Primer Octicons copilot icon\n${await readFile(`${root}resources/octicons-LICENSE`, "utf8")}`);
await writeFile(`${assets}history-licenses.txt`, notices.join("\n\n"));
