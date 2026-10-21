import { readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const { joinSession, createProvider, send, canvas } = vi.hoisted(() => {
    const canvas = { id: "vim-markdown" };
    return {
        canvas,
        joinSession: vi.fn(),
        createProvider: vi.fn(() => ({ canvas })),
        send: vi.fn(),
    };
});
vi.mock("@github/copilot-sdk/extension", () => ({
    joinSession,
    createCanvas: vi.fn(),
    CanvasError: class extends Error {},
}));
vi.mock("../../src/backend/canvas-provider.mjs", () => ({ createProvider }));

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("marketplace lists the root Agent Plugins package and its discoverable canvas entry", async () => {
    const marketplace = await readJson(".github/plugin/marketplace.json");
    const plugin = await readJson("plugin.json");
    const pkg = await readJson("package.json");
    expect(marketplace).toMatchObject({
        name: pkg.name,
        owner: { name: "davelosert" },
        plugins: [{ name: pkg.name, version: pkg.version, source: "." }],
    });
    expect(plugin).toMatchObject({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: pkg.name,
        version: pkg.version,
    });
    const directories = await readdir(new URL("com.github.copilot/extensions/", root));
    expect(directories).toEqual(["vim-canvas"]);
    await expect(readFile(new URL("com.github.copilot/extensions/vim-canvas/extension.mjs", root), "utf8"))
        .resolves.toContain('import "../../../extension.mjs"');
});

test("installed plugin entry registers the production provider with installation-root assets", async () => {
    vi.resetModules();
    const on = vi.fn();
    joinSession.mockResolvedValue({ send, sessionId: "plugin-session", on, log: vi.fn() });
    try {
        await import("../../com.github.copilot/extensions/vim-canvas/extension.mjs");
        expect(joinSession).toHaveBeenCalledExactlyOnceWith({ canvases: [canvas] });
        expect(on).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
        expect(createProvider).toHaveBeenCalledOnce();
        const options = createProvider.mock.lastCall[0];
        expect(options.root).toBe(dirname(fileURLToPath(new URL("../../extension.mjs", import.meta.url))));
        expect(options.sdk).toMatchObject({ createCanvas: expect.any(Function), CanvasError: expect.any(Function) });
        const message = { prompt: "Explain this file", mode: "immediate" };
        options.sendMessage(message);
        expect(send).toHaveBeenCalledExactlyOnceWith(message);
    } finally {
        vi.clearAllMocks();
    }
});
