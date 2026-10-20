import { test, expect } from "vitest";
import { symlink, truncate } from "node:fs/promises";
import { join } from "node:path";
import { documentFixture, Workspace, writeFiles, startEditorServer, apiClient } from "../helpers/fixtures.mjs";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="green" d="M0 0h32v32H0z"/></svg>';

test("image API requires authentication and resolves encoded paths relative to the requested document", async () => {
    const { root, store, document } = await documentFixture({ name: "docs/note.md" });
    await writeFiles(root, { "art/logo one.svg": svg, "secret.txt": "not an image", "docs/folder.svg/file.txt": "x" });
    const workspace = await Workspace.create({ rootPath: root });
    const entry = await startEditorServer({ store, document, workspace });
    const { call, url } = apiClient(entry);
    expect((await fetch(new URL("/api/image", url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: document.path, source: "../art/logo%20one.svg" }),
    })).status).toBe(403);
    const response = await call("image", { path: document.path, source: "../art/logo%20one.svg?version=1#icon" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` });
    for (const source of ["https://example.com/a.svg", "//example.com/a.svg", "file:///etc/passwd", "data:image/png;base64,abc", "javascript:bad", "", "../secret.txt", "folder.svg", "../art/missing.svg", "../art/%2Fetc.svg"]) {
        const rejected = await call("image", { path: document.path, source });
        expect(rejected.status, source).toBeGreaterThanOrEqual(400);
        expect(await rejected.json()).toHaveProperty("message");
    }
});

test("image API rejects workspace escapes, symlinks and oversized files", async () => {
    const { root, store, document } = await documentFixture({ name: "project/note.md" });
    await writeFiles(root, { "outside.svg": svg, "project/large.png": "" });
    await symlink(join(root, "outside.svg"), join(root, "project", "escape.svg"));
    await truncate(join(root, "project", "large.png"), 5 * 1024 * 1024 + 1);
    const workspace = await Workspace.create({ rootPath: join(root, "project") });
    const { call } = apiClient(await startEditorServer({ store, document, workspace }));
    for (const source of ["../outside.svg", "%2e%2e/outside.svg", "escape.svg"]) {
        const rejected = await call("image", { path: document.path, source });
        expect(rejected.status).toBe(403);
        expect(await rejected.json()).toMatchObject({ error: "outside_root" });
    }
    const large = await call("image", { path: document.path, source: "large.png" });
    expect(large.status).toBe(400);
    expect(await large.json()).toMatchObject({ error: "unsupported_image" });
});
