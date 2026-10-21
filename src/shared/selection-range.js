/** Resolve frozen UTF-16 protocol coordinates only when the captured text matches. */
export function selectionRange(content, attachment) {
    if (typeof content !== "string" || typeof attachment?.text !== "string") return null;
    const { start, end } = attachment.selection ?? {}, { text } = attachment;
    const normalized = content.replace(/\r\n/g, "\n"), lines = normalized.split("\n");
    const position = (value) => {
        if (!value || !Number.isSafeInteger(value.line) || !Number.isSafeInteger(value.character) ||
            value.line < 0 || value.line >= lines.length || value.character < 0 || value.character > lines[value.line].length) return null;
        let offset = value.character;
        for (let index = 0; index < value.line; index++) offset += lines[index].length + 1;
        return offset;
    };
    const from = position(start), to = position(end);
    return from !== null && to !== null && from <= to && normalized.slice(from, to) === text.replace(/\r\n/g, "\n")
        ? { from, to } : null;
}
