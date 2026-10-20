import { test, expect, vi } from "vitest";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { joinSession, execFile } = vi.hoisted(() => ({ joinSession: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("@github/copilot-sdk/extension", () => ({
    joinSession,
    createCanvas: (definition) => definition,
    CanvasError: class extends Error {
        constructor(code, message) { super(message); this.code = code; }
    },
}));

const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = "../../.github/extensions/vim-canvas-dev/extension.mjs";

test("dev entry waits for session storage and uses the current checkout", async ({ onTestFinished }) => {
    vi.resetModules();
    const workspacePath = await realpath(await mkdtemp(join(tmpdir(), "vim-dev-session-")));
    let resolveSession;
    joinSession.mockReturnValue(new Promise((resolve) => { resolveSession = resolve; }));
    const loading = import(entry);
    await vi.waitFor(() => expect(joinSession).toHaveBeenCalled());
    const canvas = joinSession.mock.lastCall[0].canvases[0];
    onTestFinished(async () => {
        await canvas.onClose({ instanceId: "dev" });
        await rm(workspacePath, { recursive: true, force: true });
        joinSession.mockReset();
    });
    expect(canvas).toMatchObject({ id: "vim-markdown-dev", displayName: "Vim Copilot Canvas (Dev)" });
    let opened = false;
    const opening = canvas.open({ instanceId: "dev", input: { filePath: join(root, "README.md") } }).then((value) => {
        opened = true;
        return value;
    });
    await Promise.resolve();
    expect(opened).toBe(false);
    resolveSession({ workspacePath, send: vi.fn() });
    await loading;
    const { url } = await opening;
    const action = (name, input) => canvas.actions.find((value) => value.name === name).handler({ instanceId: "dev", input });
    expect((await action("get_document")).path).toBe(join(await realpath(root), "README.md"));
    expect((await action("list_files")).entries.some(({ name }) => name === "src")).toBe(true);
    expect((await action("open_file", { path: "resources/welcome.md" })).name).toBe("welcome.md");
    expect(await (await fetch(new URL(url).origin + "/")).text()).toContain("<!doctype html>");
    expect(await (await fetch(new URL(url).origin + "/")).text()).toContain('id="dev-reload-button"');
    const reload = (headers = {}) => fetch(new URL("/api/dev/reload", url), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Editor-Token": new URL(url).hash.slice(1), ...headers },
        body: "{}",
    });
    expect((await reload({ "X-Editor-Token": "" })).status).toBe(403);
    expect((await reload({ Origin: "https://example.com" })).status).toBe(403);
    expect(execFile).not.toHaveBeenCalled();
    let finishBuild;
    execFile.mockImplementation((_node, _args, _options, callback) => { finishBuild = callback; });
    const rebuilding = reload();
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledOnce());
    expect(execFile.mock.lastCall.slice(0, 3)).toEqual([process.execPath, [join(root, "scripts/build.mjs")], { cwd: root }]);
    finishBuild(new Error("Build failed: syntax error"));
    const failure = await rebuilding;
    expect(failure.status).toBe(500);
    expect((await failure.json()).message).toContain("Build failed: syntax error");
    execFile.mockImplementation((_node, _args, _options, callback) => callback(null, "", ""));
    expect((await reload()).status).toBe(200);
    execFile.mockReset();
    expect((await stat(join(workspacePath, "vim-canvas-dev", "drafts"))).isDirectory()).toBe(true);
});

test("dev entry reports missing session storage instead of using checkout artifacts", async () => {
    vi.resetModules();
    joinSession.mockResolvedValue({ send: vi.fn() });
    await import(entry);
    const canvas = joinSession.mock.lastCall[0].canvases[0];
    await expect(canvas.open({ instanceId: "missing" })).rejects.toMatchObject({ code: "dev_storage_unavailable" });
    joinSession.mockReset();
});
