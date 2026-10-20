export function createScrollSync({ editor, editorContent, preview }) {
    const win = preview.ownerDocument.defaultView;
    const panes = [editor, preview];
    const expected = new Map();
    const positions = new Map(panes.map((pane) => [pane, pane.scrollTop]));
    const sizes = new Map();
    let enabled = false, active = editor, frame;
    const range = (pane) => Math.max(0, pane.scrollHeight - pane.clientHeight);
    const visible = (pane) => pane.clientHeight > 0 && pane.clientWidth > 0;
    const size = (pane) => `${pane.clientWidth}:${pane.clientHeight}`;
    const sync = () => {
        frame = undefined;
        // A resize frame may precede a scroll event; only stable-size panes represent user movement.
        for (const pane of panes) {
            if (visible(pane) && sizes.get(pane) === size(pane) && Math.abs(pane.scrollTop - positions.get(pane)) >= 1 &&
                Math.abs(pane.scrollTop - (expected.get(pane) ?? -1)) >= 1) active = pane;
            positions.set(pane, pane.scrollTop);
            sizes.set(pane, size(pane));
        }
        const other = active === editor ? preview : editor;
        if (!enabled || !visible(active) || !visible(other)) return;
        const height = range(active);
        const progress = height ? Math.max(0, Math.min(1, active.scrollTop / height)) : 0;
        const top = progress * range(other);
        if (Math.abs(other.scrollTop - top) < 1) return;
        other.scrollTop = top;
        positions.set(other, other.scrollTop);
        // Scroll events arrive asynchronously, after this assignment has returned.
        expected.set(other, other.scrollTop);
    };
    const refresh = () => {
        if (frame === undefined) frame = win.requestAnimationFrame(sync);
    };
    const scroll = (event) => {
        const pane = event.currentTarget;
        const target = expected.get(pane);
        expected.delete(pane);
        positions.set(pane, pane.scrollTop);
        if (!enabled || !visible(pane)) return;
        if (sizes.get(pane) === size(pane) && (target === undefined || Math.abs(pane.scrollTop - target) >= 1)) active = pane;
        refresh();
    };
    for (const pane of panes) pane.addEventListener("scroll", scroll, { passive: true });
    const observer = new win.ResizeObserver(refresh);
    for (const pane of panes) observer.observe(pane);
    observer.observe(editorContent);
    return {
        document(markdown, { reset = false } = {}) {
            enabled = markdown;
            expected.clear();
            if (reset) {
                active = editor;
                for (const pane of panes) {
                    pane.scrollTop = 0;
                    positions.set(pane, pane.scrollTop);
                }
            }
            refresh();
        },
        refresh,
        dispose() {
            win.cancelAnimationFrame(frame);
            observer.disconnect();
            for (const pane of panes) pane.removeEventListener("scroll", scroll);
        },
    };
}
