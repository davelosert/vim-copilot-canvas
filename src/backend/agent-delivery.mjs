import { basename } from "node:path";
import { EditorError } from "./errors.mjs";
import { selectionRange } from "../shared/selection-range.js";

export function requestContext(input, attachments) {
    if (input.context === undefined) return undefined;
    const content = input.context;
    if (typeof content !== "string" || Buffer.byteLength(content) > 2 * 1024 * 1024 ||
        !attachments.every((attachment) => selectionRange(content, attachment))) {
        throw new EditorError("invalid_input", "The captured document does not match the request selections.", 400);
    }
    return content;
}

export function buildAttachments(target, selections) {
    if (!Array.isArray(selections) || !selections.length || selections.length > 10000) {
        throw new EditorError("invalid_input", "Editor context is required.", 400);
    }
    const validPosition = (position) => position && Number.isSafeInteger(position.line) && position.line >= 0 &&
        Number.isSafeInteger(position.character) && position.character >= 0;
    return selections.map((selection) => {
        if (!selection || !validPosition(selection.start) || !validPosition(selection.end) ||
            typeof selection.text !== "string" || Buffer.byteLength(selection.text) > 2 * 1024 * 1024 ||
            selection.end.line < selection.start.line ||
            (selection.end.line === selection.start.line && selection.end.character < selection.start.character)) {
            throw new EditorError("invalid_input", "The editor selection is invalid.", 400);
        }
        const { start, end, text } = selection;
        const lastLine = end.line > start.line && end.character === 0 ? end.line : end.line + 1;
        return {
            type: "selection", filePath: target.path,
            displayName: `${basename(target.path)}:${start.line + 1}${lastLine === start.line + 1 ? "" : `-${lastLine}`}`,
            selection: { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } },
            text,
        };
    });
}

export function validPrompt(prompt) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 32000) {
        throw new EditorError("invalid_input", "Provide a prompt of up to 32,000 characters.", 400);
    }
    return prompt.trim();
}

/**
 * Create the per-server delivery function. Only one message may be in flight;
 * every message is sent with immediate mode.
 * @param {((message: object) => Promise<string>) | undefined} sendMessage
 */
export function createDelivery(sendMessage) {
    let sending = false;
    return async (message) => {
        if (!sendMessage) throw new EditorError("agent_unavailable", "The agent is not connected. Reopen the canvas in a Copilot session.", 503);
        if (sending) throw new EditorError("agent_busy", "A message is already being sent.", 409);
        sending = true;
        try { return await sendMessage({ ...message, mode: "immediate" }); }
        finally { sending = false; }
    };
}
