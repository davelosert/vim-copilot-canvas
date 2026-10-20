import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { releaseMetadata } from "../../scripts/release-metadata.mjs";

let root;
const writeJson = (path, value) => writeFile(join(root, path), `${JSON.stringify(value)}\n`);
const readJson = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vim-release-"));
    await mkdir(join(root, ".github/plugin"), { recursive: true });
    await writeJson("package.json", { name: "vim-copilot-canvas", version: "1.0.1", private: true });
    await writeJson("package-lock.json", { version: "1.0.1", packages: { "": { version: "1.0.1" } } });
    await writeJson("plugin.json", { name: "vim-copilot-canvas", version: "1.0.1", extensions: { keep: true } });
    await writeJson(".github/plugin/marketplace.json", {
        metadata: { version: "1.0.1", description: "Keep me" },
        plugins: [{ name: "vim-copilot-canvas", version: "1.0.1", source: "." }],
    });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

it("synchronizes both manifests without altering unrelated metadata", async () => {
    await writeJson("package.json", { name: "vim-copilot-canvas", version: "2.0.0", private: true });
    await expect(releaseMetadata("check", root)).rejects.toThrow("Release versions differ");
    await releaseMetadata("sync", root);
    expect(await readJson("plugin.json")).toMatchObject({ version: "2.0.0", extensions: { keep: true } });
    expect(await readJson(".github/plugin/marketplace.json")).toEqual({
        metadata: { version: "2.0.0", description: "Keep me" },
        plugins: [{ name: "vim-copilot-canvas", version: "2.0.0", source: "." }],
    });
    await expect(releaseMetadata("check", root)).rejects.toThrow("Release versions differ");
    await writeJson("package-lock.json", { version: "2.0.0", packages: { "": { version: "2.0.0" } } });
    await expect(releaseMetadata("check", root)).resolves.toBe("2.0.0");
});

it("rejects unknown commands, missing versions, and mismatched package names", async () => {
    await expect(releaseMetadata("typo", root)).rejects.toThrow("mode");
    await writeJson("package.json", { name: "vim-copilot-canvas" });
    await expect(releaseMetadata("sync", root)).rejects.toThrow("release version");
    await writeJson("package.json", { name: "another-plugin", version: "1.0.1" });
    await expect(releaseMetadata("sync", root)).rejects.toThrow("names must match");
});
