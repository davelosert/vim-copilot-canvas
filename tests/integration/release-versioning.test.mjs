import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { releaseMetadata } from "../../scripts/release-metadata.mjs";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

it("versions and tags the private plugin with native Changesets release events", async () => {
    const root = await mkdtemp(join(tmpdir(), "vim-release-version-"));
    try {
        await mkdir(join(root, ".github/plugin"), { recursive: true });
        await mkdir(join(root, ".changeset"));
        for (const path of ["package.json", "package-lock.json", "plugin.json", "scripts", ".changeset/config.json",
            ".changeset/README.md",
            ".github/plugin/marketplace.json"]) {
            await cp(join(repository, path), join(root, path), { recursive: true });
        }
        for (const path of ["package.json", "package-lock.json"]) {
            const value = JSON.parse(await readFile(join(root, path), "utf8"));
            value.version = "1.0.0";
            if (value.packages) value.packages[""].version = "1.0.0";
            await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
        }
        await releaseMetadata("sync", root);
        await writeFile(join(root, ".changeset/test-release.md"), '---\n"vim-copilot-canvas": patch\n---\n\nTest release.\n');
        await symlink(join(repository, "node_modules"), join(root, "node_modules"), "junction");
        await exec("git", ["init", "--quiet"], { cwd: root });
        await exec("git", ["add", "package.json", "package-lock.json", "plugin.json", ".github", ".changeset", "scripts"], { cwd: root });
        await exec("git", ["-c", "user.name=Release test", "-c", "user.email=release@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial release fixture"], { cwd: root });
        const npm = process.platform === "win32" ? "npm.cmd" : "npm";
        await exec(npm, ["run", "version:release"], {
            cwd: root,
            shell: process.platform === "win32",
            env: { ...process.env, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" },
        });
        const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
        expect(pkg.version).toBe("1.0.1");
        expect(pkg.private).toBe(true);
        await expect(releaseMetadata("check", root)).resolves.toBe("1.0.1");
        expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toContain("## 1.0.1");
        expect((await readdir(join(root, ".changeset"))).filter((name) => name.endsWith(".md"))).toEqual(["README.md"]);
        await exec("git", ["add", "."], { cwd: root });
        const gitIdentity = ["-c", "user.name=Release test", "-c", "user.email=release@example.invalid",
            "-c", "commit.gpgsign=false"];
        await exec("git", [...gitIdentity, "commit", "--quiet", "-m", "Version plugin"], { cwd: root });
        const output = join(root, "release-output.ndjson");
        const publishOptions = {
            cwd: root,
            shell: process.platform === "win32",
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "Release test",
                GIT_AUTHOR_EMAIL: "release@example.invalid",
                GIT_COMMITTER_NAME: "Release test",
                GIT_COMMITTER_EMAIL: "release@example.invalid",
                CHANGESETS_OUTPUT: output,
                npm_config_offline: "true",
                npm_config_registry: "http://127.0.0.1:1",
            },
        };
        await exec("git", ["config", "tag.gpgsign", "false"], { cwd: root });
        await exec(npm, ["run", "release"], publishOptions);
        expect(JSON.parse((await readFile(output, "utf8")).trim())).toEqual({
            type: "git-tag", tag: "v1.0.1", packageName: "vim-copilot-canvas",
        });
        expect((await exec("git", ["rev-list", "-n", "1", "v1.0.1"], { cwd: root })).stdout)
            .toBe((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout);
        await exec(npm, ["run", "release"], publishOptions);
        expect((await readFile(output, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
