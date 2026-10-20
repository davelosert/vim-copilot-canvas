import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { checkAssets } from "../../scripts/check-assets.mjs";

let root;
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vim-build-assets-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets/editor.js"), "built");
    git("init", "--quiet");
    git("add", "assets");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial build");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("accepts clean assets and ignores unrelated source changes", async () => {
    await writeFile(join(root, "source.js"), "changed source");
    expect(() => checkAssets(root)).not.toThrow();
});

it("rejects modified and staged generated files", async () => {
    await writeFile(join(root, "assets/editor.js"), "new build");
    expect(() => checkAssets(root)).toThrow("commit all assets/ changes");
    git("add", "assets");
    expect(() => checkAssets(root)).toThrow("editor.js");
});

it("rejects deleted stale chunks and new untracked chunks", async () => {
    await rm(join(root, "assets/editor.js"));
    expect(() => checkAssets(root)).toThrow("editor.js");
    await writeFile(join(root, "assets/editor.js"), "built");
    await writeFile(join(root, "assets/new-chunk.js"), "new");
    expect(() => checkAssets(root)).toThrow("new-chunk.js");
});
