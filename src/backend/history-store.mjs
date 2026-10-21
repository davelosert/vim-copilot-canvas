import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "../../assets/history-lock.mjs";
import { diffSummary } from "../../assets/history-diff.mjs";
import { atomicWrite } from "./files.mjs";
import { EditorError } from "./errors.mjs";
import { selectionRange } from "../shared/selection-range.js";

const key = (path) => createHash("sha256").update(path).digest("hex");
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const invalid = () => new EditorError("history_invalid", "Saved history is invalid. History capture cannot continue safely.", 500);
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(id);
const queues = new Map();

export class HistoryStore {
    constructor(directory, { maxEntries = 100, maxBytes = 20 * 1024 * 1024, now = Date.now } = {}) {
        this.directory = directory;
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.now = now;
        this.sent = new Map();
    }

    async locked(operation) {
        const previous = queues.get(this.directory) ?? Promise.resolve();
        const run = previous.catch(() => {}).then(async () => {
            await mkdir(join(this.directory, "documents"), { recursive: true, mode: 0o700 });
            await mkdir(join(this.directory, "requests"), { recursive: true, mode: 0o700 });
            await mkdir(join(this.directory, "receipts"), { recursive: true, mode: 0o700 });
            await mkdir(join(this.directory, "deliveries"), { recursive: true, mode: 0o700 });
            const release = await lock(this.directory, {
                retries: { retries: 25, minTimeout: 20, maxTimeout: 200 },
            });
            try { return await operation(); }
            finally { await release(); }
        });
        queues.set(this.directory, run);
        try { return await run; }
        finally { if (queues.get(this.directory) === run) queues.delete(this.directory); }
    }

    file(path) { return join(this.directory, "documents", `${key(path)}.json`); }
    requestFile(id) {
        if (!validId(id)) throw new EditorError("invalid_input", "Invalid history entry ID.", 400);
        return join(this.directory, "requests", `${id}.json`);
    }
    deliveryFile(id) { this.requestFile(id); return join(this.directory, "deliveries", `${id}.json`); }
    async removeDelivery(id) {
        try { await unlink(this.deliveryFile(id)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    async readJson(path) {
        try { return JSON.parse(await readFile(path, "utf8")); }
        catch (error) {
            if (error.code === "ENOENT") return null;
            if (error instanceof SyntaxError) throw invalid();
            throw error;
        }
    }
    async read(path, disk) {
        const value = await this.readJson(this.file(path));
        if (!value) return { schema: 1, path, disk, version: null, pruned: 0, events: [] };
        if (value.schema !== 1 || value.path !== path || typeof value.disk !== "string" ||
            typeof value.version !== "string" || !Number.isSafeInteger(value.pruned) || !Array.isArray(value.events) ||
            !value.events.every((event) => validId(event.id) && typeof event.time === "string" &&
                (event.type === "change" ? ["vim", "external"].includes(event.source) &&
                    typeof event.before === "string" && typeof event.after === "string" &&
                    (!event.agent || (typeof event.agent.sessionId === "string" &&
                        typeof event.agent.toolCallId === "string" && Array.isArray(event.agent.messageIds) &&
                        event.agent.messageIds.every((id) => typeof id === "string") &&
                        Array.isArray(event.agent.requestIds) && event.agent.requestIds.every(validId))) :
                    ["request", "batch"].includes(event.type) && Number.isSafeInteger(event.payloadBytes)))) throw invalid();
        return value;
    }
    async write(value) {
        const removed = [];
        value.version = randomUUID();
        const size = () => bytes(value) + value.events.reduce((sum, event) => sum + (event.payloadBytes ?? 0), 0);
        while (value.events.length && (value.events.length > this.maxEntries || size() > this.maxBytes)) {
            removed.push(value.events.shift());
            value.pruned++;
        }
        if (size() > this.maxBytes) throw new EditorError("history_full", "The history baseline exceeds the storage limit.", 413);
        await atomicWrite(this.file(value.path), JSON.stringify(value));
        if (removed.some((event) => event.type !== "change")) await this.collect();
    }
    change(value, before, after, source, revision) {
        if (before === after) return;
        const time = this.now();
        const last = value.events.at(-1);
        if (source === "vim" && last?.type === "change" && !last.closed && last.source === source &&
            last.after === before) {
            last.after = after;
            last.time = new Date(time).toISOString();
            last.revision = revision;
            last.counts = diffSummary(last.before, after);
            if (last.before === after) value.events.pop();
        } else value.events.push({
            id: randomUUID(), type: "change", source, time: new Date(time).toISOString(),
            started: time, before, after, revision, counts: diffSummary(before, after),
        });
    }
    async linkAgent(value, agent) {
        const last = value.events.at(-1);
        if (last?.type !== "change" || last.source !== "external" || last.after !== value.disk ||
            !Number.isFinite(agent.started) || last.started < agent.started) return false;
        if (last.agent?.sessionId === agent.sessionId && last.agent?.toolCallId === agent.toolCallId) return false;
        const requestIds = [];
        for (const event of value.events) {
            if (event.type === "change") continue;
            const request = await this.readRequest(event.id);
            if (request.status === "sent" && agent.messageIds.includes(request.messageId)) requestIds.push(event.id);
        }
        last.agent = { ...agent, requestIds };
        return true;
    }
    async observe(path, disk, agent) {
        return this.locked(async () => {
            const value = await this.read(path, disk);
            if (value.pendingSave === disk) {
                value.disk = disk;
                delete value.pendingSave;
            } else if (value.pendingSave !== undefined) {
                if (value.disk === disk) return value.version;
                delete value.pendingSave;
            } else if (value.disk === disk && value.version !== null) {
                if (agent && await this.linkAgent(value, agent)) await this.write(value);
                return value.version;
            }
            if (value.disk !== disk) {
                this.change(value, value.disk, disk, "external");
                value.disk = disk;
                if (agent) await this.linkAgent(value, agent);
            }
            // Establish a durable baseline even before the first edit.
            await this.write(value);
            return value.version;
        });
    }
    async local(path, before, after, revision) {
        return this.locked(async () => {
            const value = await this.read(path, before);
            if (!value.events.some((event) => event.revision === revision)) {
                this.change(value, before, after, "vim", revision);
                await this.write(value);
            }
        });
    }
    async saved(path, content) {
        return this.locked(async () => {
            const value = await this.read(path, content);
            value.disk = content;
            delete value.pendingSave;
            await this.write(value);
        });
    }
    async saving(path, content) {
        return this.locked(async () => {
            const value = await this.read(path, content);
            value.pendingSave = content;
            await this.write(value);
        });
    }
    async readRequest(id) {
        const request = await this.readJson(this.requestFile(id));
        if (!request || request.id !== id || !["prepared", "failed", "sent"].includes(request.status) ||
            !["request", "batch"].includes(request.type) || typeof request.prompt !== "string" ||
            !Array.isArray(request.items) || !request.items.every((item) =>
                typeof item.path === "string" && typeof item.prompt === "string" && Array.isArray(item.attachments) &&
                item.attachments.every((attachment) => attachment.filePath === item.path &&
                    typeof attachment.text === "string" && attachment.selection?.start && attachment.selection?.end)) ||
            (request.snapshots !== undefined && (!Array.isArray(request.snapshots) ||
                !request.snapshots.every((snapshot) => typeof snapshot.path === "string" && typeof snapshot.content === "string"))) ||
            !request.items.every((item) => item.snapshot === undefined ||
                (Number.isSafeInteger(item.snapshot) && request.snapshots?.[item.snapshot]?.path === item.path &&
                    item.attachments.every((attachment) => selectionRange(request.snapshots[item.snapshot].content, attachment))))) throw invalid();
        return request;
    }
    async prepare({ id = randomUUID(), type, prompt, items }) {
        return this.locked(async () => {
            const snapshots = [];
            const contexts = new Map();
            items = items.map(({ context, ...item }) => {
                if (context === undefined) return item;
                if (typeof context !== "string" || Buffer.byteLength(context) > 2 * 1024 * 1024 ||
                    !item.attachments.every((attachment) => selectionRange(context, attachment))) {
                    throw new EditorError("invalid_input", "The captured document does not match the request selections.", 400);
                }
                const identity = JSON.stringify([item.path, context]);
                if (!contexts.has(identity)) {
                    contexts.set(identity, snapshots.length);
                    snapshots.push({ path: item.path, content: context });
                }
                return { ...item, snapshot: contexts.get(identity) };
            });
            const signature = { type, prompt, items, ...(snapshots.length ? { snapshots } : {}) };
            const fingerprint = key(JSON.stringify(signature));
            this.requestFile(id);
            const receipt = await this.readJson(join(this.directory, "receipts", `${id}.json`));
            if (receipt) {
                if (receipt.fingerprint !== fingerprint) throw new EditorError("delivery_conflict", "This delivery ID belongs to another request.", 409);
                if (receipt.status === "sent") return { id, status: "sent", messageId: receipt.messageId, pruned: true };
            }
            const existing = await this.readJson(this.requestFile(id));
            if (existing) {
                const request = await this.readRequest(id);
                if (JSON.stringify(signature) !== JSON.stringify({
                    type: request.type, prompt: request.prompt, items: request.items,
                    ...(request.snapshots ? { snapshots: request.snapshots } : {}),
                })) throw new EditorError("delivery_conflict", "This delivery ID belongs to another request.", 409);
                if (this.sent.has(id)) return { ...request, status: "sent", messageId: this.sent.get(id) };
                if (request.status !== "failed") return request;
            }
            const request = { id, ...signature, fingerprint, status: "prepared", time: new Date(this.now()).toISOString() };
            if (bytes(request) + 2 * 1024 * 1024 + 4096 > this.maxBytes) {
                throw new EditorError("history_full", "This request is too large to retain in history; split the batch before sending.", 413);
            }
            const unresolved = await Promise.all((await readdir(join(this.directory, "deliveries")))
                .filter((name) => name.endsWith(".json"))
                .map((name) => this.readJson(join(this.directory, "deliveries", name))));
            if (unresolved.length >= this.maxEntries ||
                unresolved.reduce((sum, item) => sum + item.payloadBytes, bytes(request)) > this.maxBytes) {
                throw new EditorError("history_full", "Too many unresolved deliveries to safely record another request. Check the conversation and local history storage.", 413);
            }
            for (const path of new Set(items.map((item) => item.path))) {
                const value = await this.read(path, "");
                const last = value.events.at(-1);
                if (last?.type === "change" && last.source === "vim") { last.closed = true; await this.write(value); }
            }
            await atomicWrite(this.requestFile(id), JSON.stringify(request));
            await atomicWrite(this.deliveryFile(id), JSON.stringify({
                id, time: request.time, paths: [...new Set(items.map((item) => item.path))], payloadBytes: bytes(request),
            }));
            if (receipt) await unlink(join(this.directory, "receipts", `${id}.json`));
            return { ...request, fresh: true };
        });
    }
    async failed(id) {
        return this.locked(async () => {
            const request = await this.readRequest(id);
            await atomicWrite(join(this.directory, "receipts", `${id}.json`), JSON.stringify({
                id, status: "failed", fingerprint: request.fingerprint,
            }));
            await this.removeDelivery(id);
            await unlink(this.requestFile(id));
        });
    }
    async delivered(id, messageId) {
        this.sent.set(id, messageId);
        await this.locked(async () => {
            if ((await this.readJson(join(this.directory, "receipts", `${id}.json`)))?.status === "sent") return;
            const request = await this.readRequest(id);
            request.status = "sent";
            request.messageId = messageId;
            await atomicWrite(this.requestFile(id), JSON.stringify(request));
            await this.finalize(request);
            request.finalized = true;
            await atomicWrite(this.requestFile(id), JSON.stringify(request));
            await this.removeDelivery(id);
        });
        this.sent.delete(id);
    }
    async finalize(request) {
        for (const path of new Set(request.items.map((item) => item.path))) {
            const value = await this.read(path, "");
            if (!value.events.some((event) => event.id === request.id)) {
                const last = value.events.at(-1);
                if (last?.type === "change" && last.source === "vim") last.closed = true;
                value.events.push({
                    id: request.id, type: request.type, time: request.time,
                    count: request.items.length, preview: request.prompt.slice(0, 120),
                    payloadBytes: bytes({ ...request, finalized: true }),
                });
                for (const event of value.events) {
                    if (event.agent?.messageIds.includes(request.messageId) && !event.agent.requestIds.includes(request.id)) {
                        event.agent.requestIds.push(request.id);
                    }
                }
                value.events.sort((a, b) => a.time.localeCompare(b.time));
                await this.write(value);
            }
        }
    }
    async recover() {
        for (const name of await readdir(join(this.directory, "deliveries"))) {
            if (!name.endsWith(".json")) continue;
            const receipt = await this.readJson(join(this.directory, "receipts", name));
            if (receipt) { await this.removeDelivery(name.slice(0, -5)); continue; }
            const request = await this.readRequest(name.slice(0, -5));
            if (request.status === "sent" && !request.finalized) {
                await this.finalize(request);
                request.finalized = true;
                await atomicWrite(this.requestFile(request.id), JSON.stringify(request));
            }
            if (request.status === "sent") await this.removeDelivery(request.id);
        }
    }
    async collect() {
        const referenced = new Set();
        for (const name of await readdir(join(this.directory, "documents"))) {
            if (!name.endsWith(".json")) continue;
            const value = await this.readJson(join(this.directory, "documents", name));
            if (!value || !Array.isArray(value.events)) throw invalid();
            for (const event of value.events) if (event.type !== "change") referenced.add(event.id);
        }
        for (const name of await readdir(join(this.directory, "requests"))) {
            if (!name.endsWith(".json")) continue;
            const request = await this.readRequest(name.slice(0, -5));
            if (request.status === "sent" && request.finalized && !referenced.has(request.id)) {
                await atomicWrite(join(this.directory, "receipts", `${request.id}.json`), JSON.stringify({
                    id: request.id, status: "sent", messageId: request.messageId, fingerprint: request.fingerprint,
                }));
                await unlink(this.requestFile(request.id));
            }
        }
    }
    async list(path) {
        return this.locked(async () => {
            await this.recover();
            const value = await this.read(path, "");
            return {
                version: value.version, pruned: value.pruned,
                uncertain: (await Promise.all((await readdir(join(this.directory, "deliveries")))
                    .filter((name) => name.endsWith(".json"))
                    .map((name) => this.readJson(join(this.directory, "deliveries", name)))))
                    .filter((item) => item.paths.includes(path))
                    .map(({ id, time }) => ({ id, time })),
                entries: value.events.toReversed().map(({ before, after, started, revision, payloadBytes, ...event }) => event),
            };
        });
    }
    async detail(path, id) {
        this.requestFile(id);
        return this.locked(async () => {
            await this.recover();
            const value = await this.read(path, "");
            const event = value.events.find((item) => item.id === id);
            if (!event) throw new EditorError("history_not_found", "This history entry is no longer available.", 404);
            if (event.type === "change") {
                const requests = [];
                for (const request of value.events) {
                    if (request.type !== "change" && event.agent?.requestIds.includes(request.id)) {
                        requests.push(await this.readRequest(request.id));
                    }
                }
                return { ...event, ...(requests.length ? { requests } : {}) };
            }
            return this.readRequest(id);
        });
    }
}
