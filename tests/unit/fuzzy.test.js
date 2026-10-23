import { expect, test } from "vitest";
import { match, rank } from "../../src/shared/fuzzy.js";

const files = [
    "src/frontend/app.js",
    "src/frontend/api-client.js",
    "app/index.js",
    "docs/app/readme.md",
    "src/backend/workspace.mjs",
    "src/frontend/editor.js",
    "README.md",
    "src/frontend/explorer.js",
];
const paths = (query, options) => rank(query, files, options).map((result) => result.path);

test("exact and prefix filename matches rank before directory matches", () => {
    expect(paths("app")[0]).toBe("src/frontend/app.js");
    expect(paths("app.js")).toEqual(["src/frontend/app.js", "app/index.js"]);
    expect(paths("readme")).toEqual(["README.md", "docs/app/readme.md"]);
    expect(rank("index", ["index/other.js", "lib/index.js"]).map((result) => result.path)).toEqual(["lib/index.js", "index/other.js"]);
});

test("subsequences match across separators and word boundaries", () => {
    expect(paths("edtr")).toEqual(["src/frontend/editor.js"]);
    expect(paths("fe/ex")).toEqual(["src/frontend/explorer.js"]);
    expect(paths("wsp")).toEqual(["src/backend/workspace.mjs"]);
    expect(paths("zzz")).toEqual([]);
});

test("match reports highlighted positions and uses smart case", () => {
    expect(match("edtr", "src/frontend/editor.js").positions).toEqual([13, 14, 16, 18]);
    expect(match("RE", "README.md")).not.toBeNull();
    expect(match("RE", "docs/app/readme.md")).toBeNull();
    expect(match("re", "README.md")).not.toBeNull();
    expect(match("a p p", "app.js").positions).toEqual([0, 1, 2]);
    expect(match("", "app.js")).toEqual({ score: 0, positions: [] });
});

test("empty queries list recent files first and limit the results", () => {
    const recent = ["src/frontend/editor.js", "README.md"];
    const results = rank("", files, { recent, limit: 4 });
    expect(results.map((result) => result.path)).toEqual(["src/frontend/editor.js", "README.md", "src/frontend/app.js", "src/frontend/api-client.js"]);
    expect(results.map((result) => result.recent)).toEqual([true, true, false, false]);
    expect(rank("  ", files).length).toBe(files.length);
});

test("ties prefer recent, then shorter paths", () => {
    expect(rank("x", ["b/x.md", "a/x.md"], { recent: ["b/x.md"] })[0].path).toBe("b/x.md");
    expect(rank("x", ["long/dir/x.md", "a/x.md"])[0].path).toBe("a/x.md");
});

test("length-changing lowercase conversions retain original highlight offsets", () => {
    expect(match("txt", "\u0130file.txt")?.positions).toEqual([6, 7, 8]);
    expect(match("file", "\u0130file.txt")?.positions).toEqual([1, 2, 3, 4]);
    expect(match("txt", "\u0130dir/file.txt")?.positions).toEqual([10, 11, 12]);
    expect(match("i", "\u0130file.txt")?.positions).toEqual([0]);
    expect(rank("file", ["\u0130dir/other-file.txt", "\u0130dir/file.txt"])[0].path).toBe("\u0130dir/file.txt");
});
