import { expect, test } from "vitest";
import { matchingRequestPrompts } from "../../src/shared/request-matches.js";

const before = "Heading\nOld first line\nKeep\nOld second line\n";
function fixture() {
    const attachment = (line, text) => ({
        displayName: `a.md:${line + 1}`, text,
        selection: { start: { line, character: 0 }, end: { line, character: text.length } },
    });
    return {
        before, after: before.replace("Old first", "New first").replace("Old second", "New second"), path: "/a.md",
        agent: { requestIds: ["batch"], messageIds: ["message"] },
        requests: [{
            id: "batch", status: "sent", messageId: "message",
            snapshots: [{ path: "/a.md", content: before }],
            items: [
                { path: "/a.md", snapshot: 0, prompt: "First request", attachments: [attachment(1, "Old first line")] },
                { path: "/a.md", snapshot: 0, prompt: "Second request", attachments: [attachment(3, "Old second line")] },
                { path: "/a.md", snapshot: 0, prompt: "Unchanged request", attachments: [attachment(2, "Keep")] },
            ],
        }],
    };
}

test("only changed ranges with exact snapshot, file, message and request evidence receive prompts", () => {
    const f = fixture(), matches = matchingRequestPrompts(f);
    expect(matches.map((match) => match.prompt)).toEqual(["First request", "Second request"]);
    expect(matches.map((match) => match.position)).toEqual([
        f.after.indexOf("\nKeep"), f.after.length - 1,
    ]);
});

test("missing provenance, wrong paths, stale context, legacy selections and mismatched coordinates never imply a match", () => {
    const mutations = [
        (f) => { f.agent = undefined; },
        (f) => { f.agent.requestIds = ["unrelated"]; },
        (f) => { f.agent.messageIds = ["unrelated"]; },
        (f) => { f.requests[0].status = "prepared"; },
        (f) => { f.path = "/other.md"; },
        (f) => { f.requests[0].snapshots[0].path = "/other.md"; },
        (f) => { f.requests[0].snapshots[0].content = `Prefix\n${before}`; },
        (f) => { delete f.requests[0].snapshots; },
        (f) => { for (const item of f.requests[0].items) item.attachments[0].text = "Wrong"; },
        (f) => { for (const item of f.requests[0].items) item.attachments[0].selection.start.line = 0; },
    ];
    for (const mutate of mutations) {
        const f = fixture(); mutate(f);
        expect(matchingRequestPrompts(f)).toEqual([]);
    }
});

test("reverted changes lose their prompt but remaining matching changes retain theirs", () => {
    const f = fixture();
    f.after = before.replace("Old second", "New second");
    expect(matchingRequestPrompts(f).map((match) => match.prompt)).toEqual(["Second request"]);
    f.after = before;
    expect(matchingRequestPrompts(f)).toEqual([]);
});

test("CRLF normalization preserves exact range evidence", () => {
    const f = fixture();
    f.requests[0].snapshots[0].content = before.replace(/\n/g, "\r\n");
    f.before = f.requests[0].snapshots[0].content;
    f.after = f.after.replace(/\n/g, "\r\n");
    expect(matchingRequestPrompts(f).map((match) => match.prompt)).toEqual(["First request", "Second request"]);
});

test("changes extending outside the selected range are not annotated, even on the same line", () => {
    const f = fixture();
    f.requests[0].items = [f.requests[0].items[0]];
    f.requests[0].items[0].attachments[0] = {
        text: "first", selection: { start: { line: 1, character: 4 }, end: { line: 1, character: 9 } },
    };
    expect(matchingRequestPrompts(f)).toEqual([]);
});

test("duplicate selections do not repeat a prompt at the same changed line", () => {
    const f = fixture(), item = f.requests[0].items[0];
    item.attachments.push(item.attachments[0]);
    expect(matchingRequestPrompts(f).filter((match) => match.prompt === item.prompt)).toHaveLength(1);
});

test("full-line deletions anchor after the native deleted block, before the next surviving line", () => {
    const f = fixture();
    f.after = before.replace("Old first line\n", "");
    const [match] = matchingRequestPrompts(f);
    expect(match).toMatchObject({ prompt: "First request", position: "Heading\n".length, side: -0.5 });
});
