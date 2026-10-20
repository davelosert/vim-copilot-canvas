import { test, expect, vi } from "vitest";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { joinSession } = vi.hoisted(() => ({ joinSession: vi.fn() }));
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
