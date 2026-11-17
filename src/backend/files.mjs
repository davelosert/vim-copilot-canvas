import { randomUUID } from "node:crypto";
import { readFile, stat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { EditorError } from "./errors.mjs";

export const MAX_BYTES = 2 * 1024 * 1024;

function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        const content = bytes.subarray(2);
        if (content.byteLength % 2 !== 0) throw new TypeError("Invalid UTF-16 text");
        const littleEndian = Uint8Array.from(content);
        for (let index = 0; index < littleEndian.length; index += 2) {
            [littleEndian[index], littleEndian[index + 1]] = [littleEndian[index + 1], littleEndian[index]];
        }
        return new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(littleEndian);
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function atomicWrite(path, content, mode = 0o600) {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    let created = false;
    try {
        const handle = await open(temporary, "wx", mode);
        created = true;
        try {
            await handle.writeFile(content, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, path);
        created = false;
    } finally {
        if (created) await unlink(temporary);
    }
}

export async function diskText(path) {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) {
        throw new EditorError("unsupported_file", "Choose a text file smaller than 2 MiB.", 400);
    }
    let content;
    try {
        content = decodeText(await readFile(path));
    } catch (error) {
        if (error instanceof TypeError) throw new EditorError("unsupported_encoding", "This editor supports UTF-8 and BOM-marked UTF-16 text files.", 400);
        throw error;
    }
    if (content.includes("\0") || Buffer.byteLength(content) > MAX_BYTES) {
        throw new EditorError("unsupported_file", "This editor only supports text files smaller than 2 MiB.", 400);
    }
    return content;
}

export async function writeNew(path, content) {
    const handle = await open(path, "wx", 0o600);
    try {
        await handle.writeFile(content, "utf8");
    } finally {
        await handle.close();
    }
}
