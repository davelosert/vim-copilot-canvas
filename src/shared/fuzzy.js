// fzf-style fuzzy matching of workspace-relative ("/"-separated) paths.
const MATCH = 16;
const CONSECUTIVE = 8;
const GAP_START = 3;
const GAP_EXTEND = 1;
const IN_BASENAME = 6;
const ALL_IN_BASENAME = 24;
const EXACT_BASENAME = 1000;
const EXACT_STEM = 800;
const BASENAME_PREFIX = 300;
const RECENT = 4;

function boundary(path, index) {
    if (index === 0) return 10;
    const previous = path[index - 1];
    const current = path[index];
    if (previous === "/") return 10;
    if (previous === "_" || previous === "-" || previous === "." || previous === " ") return 8;
    if (previous >= "a" && previous <= "z" && current >= "A" && current <= "Z") return 7;
    if (!/[0-9]/.test(previous) && /[0-9]/.test(current)) return 4;
    return 0;
}

// Reused scratch arrays: matching runs once per path on every keystroke.
const buffers = {};
function buffer(name, Type, size) {
    if (!buffers[name] || buffers[name].length < size) buffers[name] = new Type(Math.max(size, 256));
    return buffers[name];
}

/**
 * Score one path. Returns null when the query is not a subsequence. Uppercase in the query
 * makes matching case-sensitive (smart case); whitespace in the query is ignored.
 */
export function match(rawQuery, path) {
    const query = rawQuery.replace(/\s+/g, "");
    if (!query) return { score: 0, positions: [] };
    const sensitive = query !== query.toLowerCase();
    const haystack = sensitive ? path : path.toLowerCase();
    const m = query.length;
    const n = path.length;
    // Cheap subsequence check before the quadratic pass; it also bounds the columns to score.
    let start = -1;
    for (let i = 0, j = 0; i < m; i++, j++) {
        j = haystack.indexOf(query[i], j);
        if (j < 0) return null;
        if (i === 0) start = j;
    }
    const last = haystack.lastIndexOf(query[m - 1]) + 1;
    const base = path.lastIndexOf("/") + 1;
    const from = buffer("from", Int32Array, m * n);
    let previous = buffer("previous", Float64Array, n).fill(-Infinity, 0, n);
    let current = buffer("current", Float64Array, n);
    for (let i = 0; i < m; i++) {
        current.fill(-Infinity, 0, n);
        let gapBest = -Infinity;
        let gapFrom = -1;
        for (let j = start + i; j < last; j++) {
            if (i > 0 && j >= 2) {
                const extended = gapBest - GAP_EXTEND;
                const started = previous[j - 2] - GAP_START;
                if (started >= extended) { gapBest = started; gapFrom = j - 2; }
                else gapBest = extended;
            }
            if (haystack[j] !== query[i]) continue;
            const own = MATCH + boundary(path, j) + (j >= base ? IN_BASENAME : 0);
            if (i === 0) { current[j] = own; continue; }
            const adjacent = j >= 1 ? previous[j - 1] + CONSECUTIVE : -Infinity;
            if (adjacent === -Infinity && gapBest === -Infinity) continue;
            if (adjacent >= gapBest) { current[j] = own + adjacent; from[i * n + j] = j - 1; }
            else { current[j] = own + gapBest; from[i * n + j] = gapFrom; }
        }
        [previous, current] = [current, previous];
    }
    let end = -1;
    for (let j = 0; j < n; j++) if (previous[j] > (end < 0 ? -Infinity : previous[end])) end = j;
    if (end < 0 || previous[end] === -Infinity) return null;
    let score = previous[end];
    const positions = new Array(m);
    for (let i = m - 1, j = end; i >= 0; i--) { positions[i] = j; j = from[i * n + j]; }
    const name = haystack.slice(base);
    const dot = name.lastIndexOf(".");
    if (name === query) score += EXACT_BASENAME;
    else if (dot > 0 && name.slice(0, dot) === query) score += EXACT_STEM;
    else if (name.startsWith(query)) score += BASENAME_PREFIX;
    else if (positions[0] >= base) score += ALL_IN_BASENAME;
    return { score, positions };
}

/**
 * Rank paths for a query. An empty query lists recent paths first, then the rest in order.
 * @returns {{ path: string, positions: number[], recent: boolean }[]}
 */
export function rank(query, paths, { recent = [], limit = 200 } = {}) {
    const recency = new Map(recent.map((path, index) => [path, index]));
    if (!query.trim()) {
        const rest = paths.filter((path) => !recency.has(path));
        return [...recent, ...rest].slice(0, limit)
            .map((path) => ({ path, positions: [], recent: recency.has(path) }));
    }
    const results = [];
    for (const path of paths) {
        const found = match(query, path);
        if (!found) continue;
        const bonus = recency.has(path) ? RECENT * (1 - recency.get(path) / (recent.length + 1)) : 0;
        results.push({ path, positions: found.positions, recent: recency.has(path), score: found.score + bonus });
    }
    results.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return results.slice(0, limit).map(({ path, positions, recent: isRecent }) => ({ path, positions, recent: isRecent }));
}
