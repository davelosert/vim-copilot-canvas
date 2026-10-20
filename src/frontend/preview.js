import { isMarkdown, renderMarkdown, wordCount } from "./markdown.js";

export function createPreview({ element, words, readText, loadImage, onRender, onError }) {
    let name = "";
    let path = "";
    let generation = 0;
    let timer;
    let disposed = false;
    const render = () => {
        if (disposed) return;
        const current = ++generation;
        if (!isMarkdown(name)) { element.replaceChildren(); return; }
        const source = readText();
        element.innerHTML = renderMarkdown(source);
        for (const image of element.querySelectorAll("img")) {
            const source = image.dataset.imageSource ?? "";
            const failed = (error) => {
                if (disposed || current !== generation) return;
                const fallback = element.ownerDocument.createElement("span");
                fallback.className = "image-error";
                fallback.textContent = `Image unavailable (${image.alt || source}): ${error.message}`;
                image.replaceWith(fallback);
                onError?.(error);
                onRender?.();
            };
            image.addEventListener("load", () => {
                if (!disposed && current === generation) onRender?.();
            }, { once: true });
            image.addEventListener("error", () => failed(new Error(`Could not decode image: ${source}`)), { once: true });
            loadImage(path, source).then(({ url }) => {
                if (!disposed && current === generation) image.src = url;
            }).catch(failed);
        }
        for (const link of element.querySelectorAll("a")) {
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
        const count = wordCount(source);
        words.textContent = `${count.toLocaleString()} word${count === 1 ? "" : "s"}`;
        onRender?.();
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
        document(snapshot) { name = snapshot.name; path = snapshot.path; clearTimeout(timer); render(); },
        edited() { clearTimeout(timer); if (isMarkdown(name)) timer = setTimeout(render, 100); },
        render,
        dispose() { disposed = true; clearTimeout(timer); element.removeEventListener("click", click); },
    };
}
