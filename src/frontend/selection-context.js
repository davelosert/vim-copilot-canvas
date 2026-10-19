/** Capture immutable protocol coordinates from an EditorState, without a view. */
export function captureContext(state, path) {
    const selected = state.selection.ranges.filter((range) => !range.empty);
    const ranges = selected.length ? selected : [state.doc.lineAt(state.selection.main.head)];
    const position = (offset) => {
        const line = state.doc.lineAt(offset);
        return { line: line.number - 1, character: offset - line.from };
    };
    const selections = ranges.map(({ from, to }) => ({
        start: position(from), end: position(to), text: state.sliceDoc(from, to),
    }));
    const first = selections[0].start.line + 1;
    const last = Math.max(...ranges.map(({ from, to }) => state.doc.lineAt(to > from ? to - 1 : to).number));
    return { path, selections, label: `${path.split("/").pop()}:${first}${last === first ? "" : `-${last}`}` };
}
