import { expect, test } from "vitest";
import { selectionRange } from "../../src/shared/selection-range.js";

const attachment = (start, end, text) => ({ selection: { start, end }, text });
const at = (line, character) => ({ line, character });

test("frozen ranges use UTF-16 coordinates and normalize CRLF, including a next-line boundary", () => {
    expect(selectionRange("heading\r\nalpha 😀beta\r\nnext", attachment(at(1, 6), at(2, 0), "😀beta\r\n")))
        .toEqual({ from: 14, to: 21 });
    expect(selectionRange("", attachment(at(0, 0), at(0, 0), ""))).toEqual({ from: 0, to: 0 });
});

test("frozen ranges reject missing, reversed, out-of-bounds, fractional and mismatched positions", () => {
    const content = "one\ntwo";
    for (const value of [
        undefined, { text: "one" },
        attachment(at(-1, 0), at(0, 3), "one"),
        attachment(at(0, 0), at(3, 0), "one"),
        attachment(at(0, 0), at(0, 4), "one"),
        attachment(at(0, 0.5), at(0, 3), "one"),
        attachment(at(1, 0), at(0, 3), "one"),
        attachment(at(0, 3), at(0, 0), "one"),
        attachment(at(0, 0), at(0, 3), "two"),
    ]) expect(selectionRange(content, value)).toBeNull();
});
