import { expect, it, vi } from "vitest";
import { createApiClient } from "../../src/frontend/api-client.js";

it("uses authenticated GET/JSON POST contracts and preserves server error codes", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ revision: "opaque" }) }));
    const api = createApiClient({ token: "token", fetch });
    await api.document("/a b.md");
    expect(fetch).toHaveBeenLastCalledWith("/api/document?path=%2Fa%20b.md", {
        method: "GET", headers: { "X-Editor-Token": "token" },
    });
    await api.draft({ path: "/a.md", revision: "old", content: "new" });
    expect(fetch).toHaveBeenLastCalledWith("/api/draft", {
        method: "POST", headers: { "X-Editor-Token": "token", "Content-Type": "application/json" },
        body: '{"path":"/a.md","revision":"old","content":"new"}', keepalive: false,
    });
    fetch.mockResolvedValue({ ok: false, json: async () => ({ message: "changed", error: "draft_conflict" }) });
    await expect(api.save({})).rejects.toMatchObject({ message: "changed", code: "draft_conflict" });
});
