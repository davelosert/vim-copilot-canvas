import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function checkAssets(root = process.cwd()) {
    const changes = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "assets/"], {
        cwd: root, encoding: "utf8",
    });
    if (changes.trim()) {
        throw new Error(`Committed assets differ from the clean build. Run npm run build and commit all assets/ changes, including deletions.\n${changes}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    checkAssets();
}
