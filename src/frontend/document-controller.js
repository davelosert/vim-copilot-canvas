const conflict = () => Object.assign(new Error("The file or draft changed while you were typing. Your local text is preserved; copy it before reloading."), { code: "draft_conflict" });

/** Sole owner of document snapshots, local generations, and serialized writes.
 * readText reads the live buffer; onDocument must apply text synchronously.
 */
export function createDocumentController({ api, readText, onState = () => {}, onDocument = () => {},
    onPoll = async () => {}, onReloading = () => {}, onRelocate = () => {} }) {
    let current = null;
    let observedDiskHash = null;
    let localVersion = 0;
    let persistedVersion = 0;
    let blocked = false;
    let saveFailed = false;
    let deleted = false;
    let disposed = false;
    let saving = false;
    let status = "";
    let error = null;
    let operations = Promise.resolve();
    let autosave = null;
    let saveTimer = null;
    const cancelScheduledSave = () => { clearTimeout(saveTimer); saveTimer = null; };
    const pending = () => localVersion !== persistedVersion;
    const getState = () => ({
        current: current && { ...current }, localVersion, persistedVersion,
        localPending: pending(), blocked, saveFailed, saving, status, error, deleted,
        dirty: pending() || Boolean(current?.dirty),
    });
    const emit = () => { if (!disposed) onState(getState()); };
    const fail = (reason) => {
        if (disposed) return;
        error = reason;
        if (pending() || current?.dirty) saveFailed = true;
        if (reason.code === "draft_conflict") blocked = true;
        if (reason.code === "disk_conflict" && current) current = { ...current, conflict: true };
        if (reason.code === "file_deleted") { deleted = true; cancelScheduledSave(); }
        status = deleted ? "File deleted" : blocked ? "Draft conflict" : "Not synced";
        emit();
    };
    const enqueue = (operation) => {
        const result = operations.catch(() => {}).then(async () => {
            if (disposed) return;
            try { return await operation(); }
            catch (reason) { fail(reason); throw reason; }
        });
        operations = result;
        return result;
    };
    function apply(snapshot, kind) {
        if (disposed) return;
        const moved = kind !== "switch" && current && snapshot.path !== current.path;
        current = snapshot;
        if (!snapshot.conflict) observedDiskHash = snapshot.diskHash;
        localVersion = persistedVersion = 0;
        blocked = saveFailed = deleted = false;
        error = null;
        status = snapshot.dirty ? "Draft recovered" : "All changes saved";
        onDocument({ ...snapshot }, { kind });
        if (moved) onRelocate({ ...snapshot });
        emit();
    }
    // The server follows explorer renames, so any response may name the document's new path.
    function take(snapshot) {
        const moved = current && snapshot.path !== current.path;
        current = snapshot;
        if (moved && !disposed) {
            onRelocate({ ...snapshot });
            emit();
        }
    }
    async function reloadChangedDisk(latest) {
        if (latest.diskHash === observedDiskHash && !latest.conflict) return false;
        onReloading(true);
        try {
            if (pending()) {
                await flushDraft();
                latest = await api.document(current.path);
            }
            const version = localVersion;
            const replacement = await api.reload({
                path: current.path, revision: latest.revision, diskHash: latest.diskHash,
            });
            if (version !== localVersion) throw conflict();
            if (!disposed) apply(replacement, "replace");
        } catch (reason) {
            if (reason.code !== "disk_conflict" && reason.code !== "draft_conflict") throw reason;
            if (pending()) throw reason;
        } finally { onReloading(false); }
        return true;
    }
    async function flushDraft({ drain = true } = {}) {
        if (blocked) throw conflict();
        while (pending() && !disposed) {
            const version = localVersion;
            const content = readText();
            status = "Recovering draft...";
            const snapshot = await api.draft({ path: current.path, revision: current.revision, content });
            if (disposed) return;
            take(snapshot);
            persistedVersion = version;
            status = pending() ? "Draft pending" : "Draft recovered";
            if (!drain) break;
        }
    }
    async function flushChanges({ drain = true } = {}) {
        saving = true;
        const recovering = saveFailed || error !== null;
        try {
            do {
                await flushDraft({ drain: false });
                if (disposed) return;
                if (current.dirty) {
                    status = "Saving...";
                    try {
                        const snapshot = await api.save({ path: current.path, revision: current.revision });
                        if (disposed) return;
                        take(snapshot);
                        // The server verified disk matched our base before writing, so this hash is our own write.
                        if (!snapshot.conflict) observedDiskHash = snapshot.diskHash;
                    } catch (reason) {
                        if (reason.code === "disk_conflict") {
                            await flushDraft();
                            const latest = await api.document(current.path);
                            if (disposed) return;
                            if (await reloadChangedDisk(latest)) return;
                        }
                        // A draft conflict must not prevent recovery of edits typed during save.
                        await flushDraft();
                        throw reason;
                    }
                }
            } while (drain && pending() && !disposed);
            saveFailed = false;
            error = null;
            status = pending() ? "Draft pending" : "All changes saved";
        } finally {
            saving = false;
        }
        if (recovering) emit();
    }
    function scheduleSave() {
        if (saveTimer !== null || autosave || disposed || deleted) return;
        // Bound write frequency even during continuous typing; read the latest text when the batch runs.
        saveTimer = setTimeout(() => {
            saveTimer = null;
            autosave = enqueue(() => flushChanges({ drain: false }));
            autosave.catch(() => {}).finally(() => {
                autosave = null;
                if (!disposed && pending() && !saveFailed && !blocked) scheduleSave();
            });
        }, 150);
    }
    async function openInternal(path, { discard = false, fromServer = false } = {}) {
        if (path === current.path && !deleted) return true;
        if (deleted) {
            // The file is gone; its remaining text cannot be saved anywhere.
        } else if (blocked) {
            if (fromServer || !discard) return false;
        } else {
            await flushDraft();
            if (!current.conflict) await flushChanges();
        }
        // Do not clear conflict ownership until opening actually succeeds.
        const snapshot = await api.open({ path });
        apply(snapshot, "switch");
        if (snapshot.dirty && !snapshot.conflict) scheduleSave();
        return !disposed;
    }
    return {
        getState,
        initialize(snapshot) {
            if (current || disposed) return;
            apply(snapshot, "switch");
            if (snapshot.dirty && !snapshot.conflict) scheduleSave();
        },
        edited() {
            if (disposed) return;
            localVersion++;
            if (!deleted) status = "Draft pending";
            scheduleSave();
        },
        save: () => { cancelScheduledSave(); return enqueue(flushChanges); },
        flushDraft: () => enqueue(() => flushDraft()),
        open: (path, options) => enqueue(() => openInternal(path, options)),
        reload: () => enqueue(async () => {
            const version = localVersion;
            const latest = await api.document(current.path);
            if (disposed) return;
            const snapshot = await api.reload({ path: current.path, revision: latest.revision, diskHash: latest.diskHash });
            if (disposed) return;
            // UI disables editing, but non-DOM consumers still get a safe guard.
            if (version !== localVersion) throw conflict();
            apply(snapshot, "replace");
            status = "Disk version loaded";
            emit();
        }),
        markDeleted: () => enqueue(() => {
            deleted = true;
            cancelScheduledSave();
            status = "File deleted";
            emit();
        }),
        poll: () => enqueue(async () => {
            if (deleted) return;
            if (!blocked && pending()) await flushDraft();
            const versionAtPollStart = localVersion;
            let snapshot = await api.document(current.path);
            if (disposed) return;
            if (snapshot.path !== current.path) take({ ...current, path: snapshot.path, name: snapshot.name });
            if (snapshot.activePath && snapshot.activePath !== current.path) {
                return openInternal(snapshot.activePath, { fromServer: true });
            }
            if (await reloadChangedDisk(snapshot)) {
                if (!disposed) await onPoll();
                return;
            }
            if (localVersion !== versionAtPollStart && snapshot.revision !== current.revision) throw conflict();
            if (blocked) return;
            if (pending()) {
                try {
                    await flushChanges();
                } catch (reason) {
                    if (reason.code !== "disk_conflict") throw reason;
                    snapshot = await api.document(current.path);
                    if (disposed) return;
                    if (await reloadChangedDisk(snapshot)) {
                        if (!disposed) await onPoll();
                        return;
                    }
                    throw reason;
                }
            }
            if (disposed) return;
            snapshot = await api.document(current.path);
            if (disposed) return;
            if (snapshot.activePath && snapshot.activePath !== current.path) {
                return openInternal(snapshot.activePath, { fromServer: true });
            }
            await onPoll();
            if (disposed) return;
            if (await reloadChangedDisk(snapshot)) return;
            if (snapshot.revision !== current.revision) {
                if (pending()) throw conflict();
                apply(snapshot, "replace");
                if (snapshot.dirty && !snapshot.conflict) scheduleSave();
            } else {
                take(snapshot);
                emit();
            }
        }),
        dispose() { disposed = true; cancelScheduledSave(); },
    };
}
