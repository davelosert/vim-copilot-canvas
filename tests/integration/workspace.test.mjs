import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { test } from "vitest";
import { resolveInitialTarget } from "../../src/backend/workspace.mjs";
import { Workspace, tempDir, workspaceTree, writeFiles } from "../helpers/fixtures.mjs";

test("workspace listing, first document and path resolution stay inside the root", async () => {
    const { base, rootDir, workspace } = await workspaceTree();
    const listing = await workspace.list();
    assert.deepEqual(listing.entries.map((e) => e.name), ["deep", "node_modules", ".hidden.md", "b2.md", "b10.md", "README.md", "script.js"]);
    assert.equal(await workspace.firstDocument(), join(rootDir, "README.md"));
    await assert.rejects(workspace.resolve(join(base, "outside.md")), { code: "outside_root" });
    await assert.rejects(workspace.resolve("../outside.md"), { code: "outside_root" });
    await assert.rejects(workspace.resolve("escape.md"), { code: "outside_root" });
    assert.equal(await workspace.resolve("deep/child.md"), join(rootDir, "deep", "child.md"));
});

test("initial selection skips binary, oversized and non-UTF-8 files", async () => {
    const root = await tempDir("vim-markdown-formats-");
    await writeFile(join(root, "a.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "b.bin"), Buffer.from([0xff, 0xfe]));
    await writeFile(join(root, "c.log"), "a".repeat(2 * 1024 * 1024 + 1));
    assert.equal(await resolveInitialTarget({ workingDirectory: root }), null);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.py"), "print('hello')\n");
    assert.equal((await resolveInitialTarget({ workingDirectory: root })).path, join(root, "src", "main.py"));
    await writeFile(join(root, "Makefile"), "all:\n\techo hello\n");
    assert.equal((await resolveInitialTarget({ workingDirectory: root })).path, join(root, "Makefile"));
    await writeFile(join(root, "README.md"), "# Hello\n");
    assert.equal((await resolveInitialTarget({ workingDirectory: root })).path, join(root, "README.md"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", ".env"), "A=1\n");
    await writeFile(join(root, "nested", "app.ts"), "export {};\n");
    assert.equal(await (await Workspace.create({ rootPath: join(root, "nested") })).firstDocument(), join(root, "nested", "app.ts"));
});

test("initial target defaults to the session working directory", async () => {
    const base = await tempDir("vim-markdown-cwd-");
    const project = join(base, "project");
    await mkdir(join(project, "docs"), { recursive: true });
    await writeFile(join(project, "docs", "guide.md"), "# Guide\n");
    const fromCwd = await resolveInitialTarget({ workingDirectory: project });
    assert.equal(fromCwd.workspace.root, project);
    assert.equal(fromCwd.path, join(project, "docs", "guide.md"));
    await writeFile(join(project, "README.md"), "# Readme\n");
    assert.equal((await resolveInitialTarget({ workingDirectory: project })).path, join(project, "README.md"));

    const explicit = await resolveInitialTarget({ rootPath: join(project, "docs"), workingDirectory: project });
    assert.equal(explicit.workspace.root, join(project, "docs"));
});

test("initial target is null for empty, missing, relative or absent working directories", async () => {
    const base = await tempDir("vim-markdown-cwd-");
    const empty = join(base, "empty");
    await mkdir(empty);
    assert.equal(await resolveInitialTarget({ workingDirectory: empty }), null);
    assert.equal(await resolveInitialTarget({ workingDirectory: join(base, "missing") }), null);
    assert.equal(await resolveInitialTarget({ workingDirectory: "relative" }), null);
    assert.equal(await resolveInitialTarget({}), null);
});

const run = (cwd, ...args) => new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

test("file search lists git files, respects .gitignore and skips deleted and ignored roots", async () => {
    const root = await tempDir("vim-files-git-");
    await writeFiles(root, {
        ".gitignore": "dist/\n*.log\n",
        "README.md": "# Readme\n",
        "src/app.js": "app\n",
        "src/deleted.js": "gone\n",
        "dist/bundle.js": "built\n",
        "debug.log": "log\n",
        "node_modules/pkg/index.js": "module\n",
        "artifacts/draft.md": "draft\n",
        "notes/untracked.md": "new\n",
    });
    await writeFile(join(root, ".gitignore"), "dist/\n*.log\nnode_modules/\n");
    await run(root, "init", "-q");
    await run(root, "add", "README.md", "src", ".gitignore");
    await unlink(join(root, "src", "deleted.js"));
    const workspace = await Workspace.create({ rootPath: root, ignore: ["artifacts"] });
    const result = await workspace.files();
    assert.equal(result.root, root);
    assert.equal(result.separator, sep);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.files, [".gitignore", "notes/untracked.md", "README.md", "src/app.js"]);

    const nested = await Workspace.create({ rootPath: join(root, "src") });
    assert.deepEqual((await nested.files()).files, ["app.js"]);
});

test("file search falls back to a walker outside git and caches until invalidated", async () => {
    const root = await tempDir("vim-files-walk-");
    await writeFiles(root, {
        "a.md": "a\n",
        "deep/nested/b.txt": "b\n",
        ".git/config": "not a repository\n",
        "node_modules/pkg/index.js": "module\n",
        "drafts/x.md": "x\n",
        ".github/workflow.yml": "on: push\n",
    });
    await symlink(join(root, "deep"), join(root, "link"));
    await symlink(join(root, "a.md"), join(root, "deep", "alias.md"));
    await symlink(join(root, "missing.md"), join(root, "dangling.md"));
    const workspace = await Workspace.create({ rootPath: root, ignore: ["drafts"] });
    const expected = [".github/workflow.yml", "a.md", "deep/alias.md", "deep/nested/b.txt"];
    assert.deepEqual((await workspace.files()).files, expected);
    await writeFile(join(root, "c.md"), "c\n");
    assert.deepEqual((await workspace.files()).files, expected);
    workspace.invalidateFiles();
    assert.deepEqual((await workspace.files()).files, [".github/workflow.yml", "a.md", "c.md", "deep/alias.md", "deep/nested/b.txt"]);
});
