import { describe, expect, it, vi } from "vitest";
import { createDocumentController } from "../../src/frontend/document-controller.js";

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const snapshot = (overrides = {}) => ({
    path: "/work/a.md", name: "a.md", content: "initial", revision: "r0",
    diskHash: "disk0", dirty: false, conflict: false, ...overrides,
});
function fixture(overrides = {}) {
    let text = "initial";
    let revision = 0;
    let server = snapshot();
    const documents = [];
    const api = {
        draft: vi.fn(async (input) => (server = { ...server, content: input.content, revision: `r${++revision}`, dirty: true })),
        save: vi.fn(async () => (server = { ...server, dirty: false, revision: `r${++revision}` })),
        document: vi.fn(async () => ({ ...server })),
        open: vi.fn(async ({ path }) => (server = snapshot({ path, name: path.split("/").pop(), content: "opened" }))),
        reload: vi.fn(async () => (server = snapshot({ content: "disk", revision: `r${++revision}` }))),
        ...overrides,
    };
    const controller = createDocumentController({
        api, readText: () => text,
        onDocument: (value, options) => { text = value.content; documents.push([value, options]); },
    });
    controller.initialize(snapshot());
    return {
        controller, api, documents, text: () => text,
        edit(value) { text = value; controller.edited(); },
        server(value) { server = value; },
    };
}

describe("document ownership and serialized persistence", () => {
    it("is DOM-free, exposes copies, and persists a draft before saving disk", async () => {
        const f = fixture();
        f.controller.getState().current.path = "not-owned";
        f.edit("new");
        await f.controller.save();
        expect(f.api.draft).toHaveBeenCalledWith({ path: "/work/a.md", revision: "r0", content: "new" });
        expect(f.api.draft.mock.invocationCallOrder[0]).toBeLessThan(f.api.save.mock.invocationCallOrder[0]);
        expect(f.controller.getState()).toMatchObject({ localVersion: 1, persistedVersion: 1, dirty: false });
        f.controller.dispose();
    });

    it("acknowledges only the captured generation and drains edits during draft and disk writes", async () => {
        const draftEntered = deferred(), draftResult = deferred(), saveEntered = deferred(), saveResult = deferred();
        const f = fixture();
        f.api.draft.mockImplementationOnce((input) => {
            draftEntered.resolve(input); return draftResult.promise;
        });
        f.api.save.mockImplementationOnce(() => { saveEntered.resolve(); return saveResult.promise; });
        f.edit("first");
        await draftEntered.promise;
        f.edit("second");
        draftResult.resolve(snapshot({ content: "first", dirty: true, revision: "r1" }));
        await saveEntered.promise;
        expect(f.controller.getState()).toMatchObject({ localVersion: 2, persistedVersion: 1, localPending: true });
        f.edit("third");
        saveResult.resolve(snapshot({ content: "first", revision: "r2" }));
        await f.controller.save();
        expect(f.api.draft.mock.calls.map(([input]) => input.content)).toEqual(["first", "third"]);
        expect(f.text()).toBe("third");
        expect(f.controller.getState()).toMatchObject({ localVersion: 3, persistedVersion: 3, dirty: false });
        f.controller.dispose();
    });

    it("does not poison the queue when saving fails and allows explicit retry", async () => {
        const f = fixture();
        f.api.save.mockRejectedValueOnce(new Error("offline"));
        f.edit("retry");
        // This explicit save follows the failed autosave in the same queue.
        await f.controller.save();
        expect(f.api.save).toHaveBeenCalledTimes(2);
        expect(f.controller.getState()).toMatchObject({ saveFailed: false, dirty: false, error: null });
        f.controller.dispose();
    });

    it("rejects callers on failure without losing pending local text", async () => {
        const f = fixture();
        f.api.save.mockRejectedValue(new Error("offline"));
        f.edit("local");
        await expect(f.controller.save()).rejects.toThrow("offline");
        expect(f.text()).toBe("local");
        expect(f.controller.getState()).toMatchObject({ saveFailed: true, dirty: true });
        f.api.save.mockImplementation(async () => snapshot({ content: "local", revision: "saved" }));
        await f.controller.save();
        expect(f.controller.getState().dirty).toBe(false);
        f.controller.dispose();
    });

    it("silently reloads the disk version after an autosave conflict and still permits switching", async () => {
        const entered = deferred(), result = deferred();
        const f = fixture();
        f.api.save.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
        f.api.document.mockResolvedValue(snapshot({
            content: "first", revision: "r1", dirty: true, diskHash: "external-disk", conflict: true,
        }));
        f.edit("first");
        await entered.promise;
        f.edit("recovery");
        result.reject(Object.assign(new Error("disk changed"), { code: "disk_conflict" }));
        await expect(f.controller.open("/work/b.md")).resolves.toBe(true);
        expect(f.api.draft.mock.calls.map(([input]) => input.content)).toEqual(["first"]);
        expect(f.api.save).toHaveBeenCalledTimes(1);
        expect(f.api.reload).toHaveBeenCalledWith({
            path: "/work/a.md", revision: "r1", diskHash: "external-disk",
        });
        expect(f.controller.getState().current.path).toBe("/work/b.md");
        f.controller.dispose();
    });

    it("preserves unsynced draft-conflict text, blocks server switches, and requires UI discard", async () => {
        const f = fixture();
        f.api.draft.mockRejectedValue(Object.assign(new Error("other panel"), { code: "draft_conflict" }));
        f.edit("unsynced");
        await expect(f.controller.save()).rejects.toMatchObject({ code: "draft_conflict" });
        expect(await f.controller.open("/work/b.md", { fromServer: true, discard: true })).toBe(false);
        expect(await f.controller.open("/work/b.md")).toBe(false);
        expect(f.text()).toBe("unsynced");
        expect(f.api.open).not.toHaveBeenCalled();
        expect(await f.controller.open("/work/b.md", { discard: true })).toBe(true);
        expect(f.controller.getState().blocked).toBe(false);
        f.controller.dispose();
    });

    it("serializes switching behind writes, retaining canonical paths and fresh-document kind", async () => {
        const entered = deferred(), result = deferred();
        const f = fixture();
        f.api.save.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
        f.api.open.mockResolvedValue(snapshot({ path: "/canonical/b.md", name: "b.md", content: "B" }));
        f.edit("A");
        await entered.promise;
        const switching = f.controller.open("b.md");
        expect(f.api.open).not.toHaveBeenCalled();
        result.resolve(snapshot({ content: "A", revision: "saved" }));
        await switching;
        expect(f.api.open).toHaveBeenCalledWith({ path: "b.md" });
        expect(f.controller.getState()).toMatchObject({ current: { path: "/canonical/b.md" }, localVersion: 0, persistedVersion: 0 });
        expect(f.documents.at(-1)[1]).toEqual({ kind: "switch" });
        f.controller.dispose();
    });

    it("opens a server-directed path inside the queue without recursively enqueueing", async () => {
        const f = fixture();
        f.api.document.mockResolvedValue(snapshot({ activePath: "/work/b.md" }));
        await f.controller.poll();
        expect(f.controller.getState().current.path).toBe("/work/b.md");
        f.controller.dispose();
    });

    it("rejects stale poll replacement when typing occurs while its request is pending", async () => {
        const entered = deferred(), result = deferred();
        const f = fixture();
        f.api.document.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
        const polling = f.controller.poll();
        await entered.promise;
        f.edit("typed during poll");
        result.resolve(snapshot({ revision: "remote", content: "other panel" }));
        await expect(polling).rejects.toMatchObject({ code: "draft_conflict" });
        expect(f.text()).toBe("typed during poll");
        expect(f.controller.getState().blocked).toBe(true);
        expect(f.documents).toHaveLength(1);
        f.controller.dispose();
    });

    it("polls same-file replacements explicitly and reloads using latest revision/hash", async () => {
        const f = fixture();
        f.server(snapshot({ content: "external", revision: "r8", diskHash: "disk8" }));
        f.api.reload.mockResolvedValueOnce(snapshot({ content: "external", revision: "r9", diskHash: "disk8" }));
        await f.controller.poll();
        expect(f.text()).toBe("external");
        expect(f.documents.at(-1)[1]).toEqual({ kind: "replace" });
        f.server(snapshot({ content: "external", revision: "r9", diskHash: "disk8" }));
        await f.controller.reload();
        expect(f.api.reload).toHaveBeenCalledWith({ path: "/work/a.md", revision: "r9", diskHash: "disk8" });
        expect(f.controller.getState().status).toBe("Disk version loaded");
        f.controller.dispose();
    });

    it("silently replaces a dirty draft when the open file changes on disk", async () => {
        const f = fixture();
        f.edit("local draft");
        await f.controller.flushDraft();
        f.api.document.mockResolvedValue(snapshot({
            content: "local draft", revision: "r1", dirty: true, diskHash: "external-disk",
        }));
        f.api.reload.mockResolvedValue(snapshot({
            content: "external", revision: "r2", diskHash: "external-disk",
        }));

        await f.controller.poll();

        expect(f.api.reload).toHaveBeenCalledWith({
            path: "/work/a.md", revision: "r1", diskHash: "external-disk",
        });
        expect(f.text()).toBe("external");
        expect(f.controller.getState()).toMatchObject({
            status: "All changes saved", blocked: false, saveFailed: false, error: null,
            current: { conflict: false, dirty: false },
        });
        f.controller.dispose();
    });

    it("guards a reload against programmatic edits during its request", async () => {
        const entered = deferred(), result = deferred();
        const f = fixture();
        f.api.reload.mockImplementation(() => { entered.resolve(); return result.promise; });
        const reload = f.controller.reload();
        await entered.promise;
        f.edit("new while reloading");
        result.resolve(snapshot({ content: "disk", revision: "reload" }));
        await expect(reload).rejects.toMatchObject({ code: "draft_conflict" });
        expect(f.text()).toBe("new while reloading");
        f.controller.dispose();
    });

    it("invalidates pending requests on disposal without replacing text or notifying", async () => {
        const entered = deferred(), result = deferred();
        const f = fixture();
        f.api.document.mockImplementation(() => { entered.resolve(); return result.promise; });
        const polling = f.controller.poll();
        await entered.promise;
        f.controller.dispose();
        result.resolve(snapshot({ content: "late", revision: "late" }));
        await polling;
        expect(f.text()).toBe("initial");
        expect(f.documents).toHaveLength(1);
    });
});
