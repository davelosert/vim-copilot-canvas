import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function formatChangelog(root = process.cwd()) {
    const path = `${root}/CHANGELOG.md`;
    const source = await readFile(path, "utf8");
    let fence;
    const formatted = source.split("\n").map((line) => {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
                fence = undefined;
            }
            return line;
        }
        if (marker) {
            fence = marker[1];
            return line;
        }
        return line
            .replace(/^### Minor Changes(\r?)$/, "### Features & Minor Changes$1")
            .replace(/^### Patch Changes(\r?)$/, "### Fixes & Patch Changes$1");
    }).join("\n");
    if (formatted !== source) {
        await writeFile(path, formatted);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await formatChangelog();
}
