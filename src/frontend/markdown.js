import { Marked } from "marked";
import markedAlert from "marked-alert";
import markedFootnote from "marked-footnote";
import { gfmHeadingId } from "marked-gfm-heading-id";
import filterXSS from "xss";

const heading = ["id", "class"];
const renderer = new Marked({ gfm: true, breaks: false })
    .use(gfmHeadingId()).use(markedAlert()).use(markedFootnote());
const sanitizer = {
    whiteList: {
        a: ["href", "title", "id", "aria-describedby", "aria-label", "data-footnote-ref", "data-footnote-backref"],
        blockquote: [], br: [], code: [], del: [], details: ["open"], div: ["class"], em: [],
        h1: heading, h2: heading, h3: heading, h4: heading, h5: heading, h6: heading, hr: [],
        input: ["type", "checked", "disabled"], kbd: [], li: ["id"], ol: ["start"], p: ["class"], pre: [],
        img: ["src", "alt", "title", "width", "height"],
        section: ["class", "data-footnotes"], strong: [], sub: [], summary: [], sup: [], table: [], tbody: [],
        td: ["align", "colspan", "rowspan"], th: ["align", "colspan", "rowspan"], thead: [], tr: [], ul: [],
    },
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script", "style", "iframe", "object", "embed", "form", "audio", "video"],
    css: false,
    onTagAttr: (tag, name, value, allowed) => {
        if (allowed && tag === "img" && name === "src") return `data-image-source="${filterXSS.escapeAttrValue(value)}"`;
        if (allowed && name === "id") return `id="user-content-${filterXSS.escapeAttrValue(value)}"`;
    },
};

export const isMarkdown = (name) => /\.(md|markdown|mdown)$/i.test(name);
export const renderMarkdown = (source) => filterXSS(renderer.parse(source), sanitizer);
export const wordCount = (source) => source.trim() ? source.trim().split(/\s+/u).length : 0;
