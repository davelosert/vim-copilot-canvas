import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { formatChangelog } from "../../scripts/format-changelog.mjs";

const exec = promisify(execFile);
let root;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vim-changelog-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

it.each(["\n", "\r\n"])("renames release sections and preserves content with %j line endings", async (newline) => {
    const source = [
        "# vim-copilot-canvas", "", "## 2.0.0", "", "### Major Changes", "",
        "- Breaking change.", "", "### Minor Changes", "", "- Feature.", "",
        "### Patch Changes", "", "- Fix.", "", "## 1.0.1", "", "### Patch Changes", "",
        "- Earlier fix mentioning Minor Changes and Patch Changes.", "",
    ].join(newline);
    const expected = source.replaceAll("### Minor Changes", "### Features & Minor Changes")
        .replaceAll("### Patch Changes", "### Fixes & Patch Changes");
    await writeFile(join(root, "CHANGELOG.md"), source);
    await formatChangelog(root);
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe(expected);
    await formatChangelog(root);
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe(expected);
});

it("leaves examples, nested headings, and unrelated headings unchanged", async () => {
    const source = [
        "````md", "### Minor Changes", "```", "### Patch Changes", "````",
        "~~~md", "### Patch Changes", "~~~",
        "    ### Minor Changes", "> ### Patch Changes", "#### Patch Changes",
        "### Minor Changes in detail", "",
    ].join("\n");
    await writeFile(join(root, "CHANGELOG.md"), source);
    await formatChangelog(root);
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe(source);
});

it("reports a missing changelog rather than silently skipping formatting", async () => {
    await expect(formatChangelog(root)).rejects.toThrow("ENOENT");
});

it("formats the changelog between Changesets versioning and release metadata synchronization", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["version:release"]).toContain(
        "changeset version && node scripts/format-changelog.mjs && node scripts/release-metadata.mjs sync",
    );
});

it("formats actual Changesets output through the release formatter CLI", async () => {
    await mkdir(join(root, ".changeset"));
    await writeFile(join(root, "package.json"), JSON.stringify({
        name: "vim-copilot-canvas", version: "1.0.0", private: true,
    }));
    await writeFile(join(root, ".changeset/config.json"),
        await readFile(new URL("../../.changeset/config.json", import.meta.url)));
    for (const type of ["major", "minor", "patch"]) {
        await writeFile(join(root, `.changeset/${type}.md`),
            `---\n"vim-copilot-canvas": ${type}\n---\n\nA ${type} change.\n`);
    }
    await exec("git", ["init", "--quiet"], { cwd: root });
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com",
        "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial changesets"], { cwd: root });
    await exec(process.execPath, [
        fileURLToPath(new URL("../../node_modules/@changesets/cli/bin.js", import.meta.url)), "version",
    ], { cwd: root });
    const generated = await readFile(join(root, "CHANGELOG.md"), "utf8");
    expect(generated).toContain("### Minor Changes");
    expect(generated).toContain("### Patch Changes");
    await exec(process.execPath, [
        fileURLToPath(new URL("../../scripts/format-changelog.mjs", import.meta.url)),
    ], { cwd: root });
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe(
        generated.replace("### Minor Changes", "### Features & Minor Changes")
            .replace("### Patch Changes", "### Fixes & Patch Changes"),
    );
});
