import { isMarkdown } from "./markdown.js";

// `renderSource(source)` resolves to `{ html, count }`; parsing runs on the canvas server.
export function createPreview({ element, words, readText, renderSource, loadImage, onRender, onError, visible = true }) {
    let name = "";
    let path = "";
    let generation = 0;
    let timer;
    let disposed = false;
    let dirty = false, busy = false, queued = false;
    let resetPosition = false;
    let blocks = [];
    function prepare(block) {
        const { node } = block;
        const images = node.nodeType === 1 ? [...(node.matches("img") ? [node] : []), ...node.querySelectorAll("img")] : [];
        for (const image of images) {
            const source = image.dataset.imageSource ?? "";
            const currentPath = path;
            const active = () => !disposed && path === currentPath && element.contains(image);
            const failed = (error) => {
                if (!active()) return;
                const fallback = element.ownerDocument.createElement("span");
                fallback.className = "image-error";
                fallback.textContent = `Image unavailable (${image.alt || source}): ${error.message}`;
                image.replaceWith(fallback);
                if (block.node === image) block.node = fallback;
                onError?.(error);
                onRender?.();
            };
            image.addEventListener("load", () => {
                if (active()) onRender?.();
            }, { once: true });
            image.addEventListener("error", () => failed(new Error(`Could not decode image: ${source}`)), { once: true });
            loadImage(path, source).then(({ url }) => {
                if (active()) image.src = url;
            }).catch(failed);
        }
        const links = node.nodeType === 1 ? [...(node.matches("a") ? [node] : []), ...node.querySelectorAll("a")] : [];
        for (const link of links) {
            const href = link.getAttribute("href") ?? "";
            if (href.startsWith("#")) continue;
            if (/^https?:\/\//i.test(href)) {
                link.target = "_blank";
                link.rel = "noopener noreferrer";
            } else {
                link.removeAttribute("href");
                link.title = "Only web links are opened from preview.";
            }
        }
    }
    function patch(html) {
        const top = element.scrollTop;
        const height = element.scrollHeight - element.clientHeight;
        const bounds = element.getBoundingClientRect();
        const anchorNode = !resetPosition && [...element.children].find((child) => child.getBoundingClientRect().bottom > bounds.top);
        const anchor = anchorNode && { text: anchorNode.textContent, tag: anchorNode.tagName,
            offset: anchorNode.getBoundingClientRect().top - bounds.top };
        const template = element.ownerDocument.createElement("template");
        template.innerHTML = html;
        // Keep the original markup for comparisons: image URLs and link attributes change after hydration.
        const next = [...template.content.childNodes].map((node) => ({
            node, html: node.nodeType === 1 ? node.outerHTML : node.textContent,
        }));
        let start = 0, end = blocks.length, nextEnd = next.length;
        while (start < end && start < nextEnd && blocks[start].html === next[start].html) {
            next[start] = blocks[start];
            start++;
        }
        while (end > start && nextEnd > start && blocks[end - 1].html === next[nextEnd - 1].html) {
            next[--nextEnd] = blocks[--end];
        }
        const insertionAnchor = blocks[end]?.node ?? null;
        for (let index = start; index < end; index++) blocks[index].node.remove();
        const fragment = element.ownerDocument.createDocumentFragment();
        for (let index = start; index < nextEnd; index++) fragment.append(next[index].node);
        element.insertBefore(fragment, insertionAnchor);
        for (let index = start; index < nextEnd; index++) prepare(next[index]);
        blocks = next;
        if (resetPosition) {
            element.scrollTop = 0;
            resetPosition = false;
        } else {
            const candidates = anchor && [...element.children].filter((child) =>
                child.tagName === anchor.tag && child.textContent === anchor.text);
            if (candidates?.length === 1) {
                element.scrollTop += candidates[0].getBoundingClientRect().top - bounds.top - anchor.offset;
            } else element.scrollTop = height > 0 ? (top / height) * (element.scrollHeight - element.clientHeight) : top;
        }
    }
    const render = async () => {
        clearTimeout(timer);
        if (disposed || !visible || !dirty || !isMarkdown(name)) return;
        if (busy) { queued = true; return; }
        const current = generation;
        busy = true;
        queued = false;
        dirty = false;
        try {
            const { html, count } = await renderSource(readText());
            if (disposed || !visible || current !== generation) return;
            patch(html);
            words.textContent = `${count.toLocaleString()} word${count === 1 ? "" : "s"}`;
            onRender?.();
        } catch (error) {
            if (!disposed && visible && current === generation) onError?.(error);
        } finally {
            busy = false;
            if (queued) render();
        }
    };
    const invalidate = () => {
        generation++;
        dirty = true;
        queued = false;
        clearTimeout(timer);
    };
    const click = (event) => {
        const link = event.target.closest?.('a[href^="#"]');
        if (!link) return;
        event.preventDefault();
        let id = link.getAttribute("href").slice(1);
        try { id = decodeURIComponent(id); } catch {}
        const target = id && element.querySelector(`[id="user-content-${CSS.escape(id)}"]`);
        target?.scrollIntoView({ block: "start" });
    };
    element.addEventListener("click", click);
    return {
        document(snapshot, { reset = false } = {}) {
            invalidate();
            resetPosition = resetPosition || reset || path !== snapshot.path;
            if (resetPosition) element.scrollTop = 0;
            if (path !== snapshot.path || !isMarkdown(snapshot.name)) {
                element.replaceChildren();
                blocks = [];
                words.textContent = "";
            }
            name = snapshot.name;
            path = snapshot.path;
            render();
        },
        edited() { invalidate(); if (visible && isMarkdown(name)) timer = setTimeout(render, 100); },
        setVisible(value) {
            if (visible === value) return;
            visible = value;
            if (!visible) invalidate();
            else render();
        },
        render,
        dispose() { disposed = true; clearTimeout(timer); element.removeEventListener("click", click); },
    };
}
