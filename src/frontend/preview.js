import { isMarkdown, renderMarkdown, wordCount } from "./markdown.js";

export function createPreview({ element, words, readText, onRender }) {
    let name = "";
    let timer;
    let disposed = false;
    const render = () => {
        if (disposed) return;
        if (!isMarkdown(name)) { element.replaceChildren(); return; }
        const source = readText();
        element.innerHTML = renderMarkdown(source);
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
        document(snapshot) { name = snapshot.name; clearTimeout(timer); render(); },
        edited() { clearTimeout(timer); if (isMarkdown(name)) timer = setTimeout(render, 100); },
        render,
        dispose() { disposed = true; clearTimeout(timer); element.removeEventListener("click", click); },
    };
}
