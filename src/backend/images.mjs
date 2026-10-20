import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EditorError } from "./errors.mjs";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const types = new Map([
    [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"],
    [".avif", "image/avif"], [".bmp", "image/bmp"], [".ico", "image/x-icon"],
]);

export async function readImage(workspace, documentPath, source) {
    if (typeof source !== "string" || !source.trim() ||
        /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source.trim()) || source.includes("\\")) {
        throw new EditorError("invalid_image", "Only local workspace images are supported.", 400);
    }
    let filePath;
    try {
        filePath = fileURLToPath(new URL(source, pathToFileURL(documentPath)));
    } catch {
        throw new EditorError("invalid_image", "The image path is invalid.", 400);
    }
    const path = await workspace.resolve(filePath);
    const type = types.get(extname(path).toLowerCase());
    if (!type) throw new EditorError("unsupported_image", "Unsupported image format.", 400);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) {
        throw new EditorError("unsupported_image", "Choose an image no larger than 5 MiB.", 400);
    }
    const bytes = await readFile(path);
    if (bytes.length > MAX_IMAGE_BYTES) {
        throw new EditorError("unsupported_image", "Choose an image no larger than 5 MiB.", 400);
    }
    return { url: `data:${type};base64,${bytes.toString("base64")}` };
}
