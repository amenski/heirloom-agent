import { describe, it, expect } from "vitest";
import {
  shouldCollapse, placeholderFor, adjustSpans, applyEditToSpans, clampSpans, collapseForDisplay,
  MIN_COLLAPSE_CHARS, type PasteSpan,
} from "./paste-spans.js";

const big = "x".repeat(MIN_COLLAPSE_CHARS);

describe("shouldCollapse", () => {
  it("leaves a short single-line paste visible", () => {
    expect(shouldCollapse("src/ui/App.tsx")).toBe(false);
  });

  it("collapses a long single-line paste", () => {
    expect(shouldCollapse(big)).toBe(true);
  });

  it("collapses any multi-line paste, however short", () => {
    expect(shouldCollapse("a\nb")).toBe(true);
  });
});

describe("placeholderFor", () => {
  it("reports char count for a single-line paste", () => {
    expect(placeholderFor("y".repeat(167))).toBe("[pasted 167 chars]");
  });

  it("reports line and char count for a multi-line paste", () => {
    expect(placeholderFor("a\nb\nc")).toBe("[pasted 3 lines, 5 chars]");
  });
});

describe("collapseForDisplay", () => {
  it("returns text unchanged when there are no spans", () => {
    expect(collapseForDisplay("hello", 2, [])).toEqual({ text: "hello", cursor: 2 });
  });

  it("replaces the span with a placeholder and keeps surrounding text", () => {
    const text = `before ${"z".repeat(10)} after`;
    const spans: PasteSpan[] = [{ start: 7, end: 17 }];
    const { text: out } = collapseForDisplay(text, text.length, spans);
    expect(out).toBe("before [pasted 10 chars] after");
  });

  it("maps a cursor sitting after the span to the collapsed coordinates", () => {
    const text = `ab${"z".repeat(10)}cd`;
    const spans: PasteSpan[] = [{ start: 2, end: 12 }];
    const { text: out, cursor } = collapseForDisplay(text, 13, spans);
    // cursor was 1 char past the span end; placeholder is 18 chars → 2 + 18 + 1
    expect(cursor).toBe("ab[pasted 10 chars]c".length);
    expect(out[cursor]).toBe("d");
  });

  it("parks a cursor inside the span just past the placeholder", () => {
    const text = `ab${"z".repeat(10)}cd`;
    const spans: PasteSpan[] = [{ start: 2, end: 12 }];
    const { cursor } = collapseForDisplay(text, 7, spans);
    expect(cursor).toBe("ab[pasted 10 chars]".length);
  });

  it("collapses several spans in one pass", () => {
    const text = `A${"z".repeat(5)}B${"q".repeat(3)}C`;
    const spans: PasteSpan[] = [{ start: 1, end: 6 }, { start: 7, end: 10 }];
    const { text: out } = collapseForDisplay(text, 0, spans);
    expect(out).toBe("A[pasted 5 chars]B[pasted 3 chars]C");
  });

  it("collapses spans given out of order", () => {
    const text = `A${"z".repeat(5)}B${"q".repeat(3)}C`;
    const spans: PasteSpan[] = [{ start: 7, end: 10 }, { start: 1, end: 6 }];
    const { text: out } = collapseForDisplay(text, 0, spans);
    expect(out).toBe("A[pasted 5 chars]B[pasted 3 chars]C");
  });
});

describe("adjustSpans", () => {
  const spans: PasteSpan[] = [{ start: 10, end: 20 }];

  it("shifts a span right when text is inserted before it", () => {
    expect(adjustSpans(spans, 0, 0, 3)).toEqual([{ start: 13, end: 23 }]);
  });

  it("shifts a span left when text is deleted before it", () => {
    expect(adjustSpans(spans, 0, 3, -3)).toEqual([{ start: 7, end: 17 }]);
  });

  it("leaves a span untouched when the edit is after it", () => {
    expect(adjustSpans(spans, 25, 25, 4)).toEqual(spans);
  });

  it("drops the span when an edit reaches into its interior", () => {
    expect(adjustSpans(spans, 15, 16, -1)).toEqual([]);
  });

  it("drops the span when a backspace eats its final character", () => {
    expect(adjustSpans(spans, 19, 20, -1)).toEqual([]);
  });

  it("drops the span when an insert lands at its trailing boundary", () => {
    // Typing right after the placeholder must not silently extend the paste.
    expect(adjustSpans(spans, 20, 20, 1)).toEqual([{ start: 10, end: 20 }]);
  });

  it("keeps a boundary insert at the span start before the span", () => {
    expect(adjustSpans(spans, 10, 10, 2)).toEqual([{ start: 12, end: 22 }]);
  });

  it("drops a span fully covered by a deletion", () => {
    expect(adjustSpans(spans, 5, 25, -20)).toEqual([]);
  });

  it("adjusts each span independently", () => {
    const two: PasteSpan[] = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
    expect(adjustSpans(two, 0, 0, 5)).toEqual([{ start: 15, end: 25 }, { start: 35, end: 45 }]);
  });
});

describe("applyEditToSpans", () => {
  // "ab" + 10 pasted chars + "cd"; the paste occupies [2, 12).
  const text = `ab${"z".repeat(10)}cd`;
  const spans: PasteSpan[] = [{ start: 2, end: 12 }];

  it("keeps the span when typing before it", () => {
    const after = `Xab${"z".repeat(10)}cd`;
    expect(applyEditToSpans(spans, text, after)).toEqual([{ start: 3, end: 13 }]);
  });

  it("keeps the span when typing after it", () => {
    const after = `ab${"z".repeat(10)}cdX`;
    expect(applyEditToSpans(spans, text, after)).toEqual([{ start: 2, end: 12 }]);
  });

  it("keeps the span when deleting before it", () => {
    const after = `b${"z".repeat(10)}cd`;
    expect(applyEditToSpans(spans, text, after)).toEqual([{ start: 1, end: 11 }]);
  });

  it("expands the paste when a character inside it is deleted", () => {
    const after = `ab${"z".repeat(9)}cd`;
    expect(applyEditToSpans(spans, text, after)).toEqual([]);
  });

  it("expands the paste when the whole buffer is cleared", () => {
    expect(applyEditToSpans(spans, text, "")).toEqual([]);
  });

  it("returns spans unchanged when the text did not change", () => {
    expect(applyEditToSpans(spans, text, text)).toEqual(spans);
  });

  it("is a no-op when there are no spans", () => {
    expect(applyEditToSpans([], text, "anything")).toEqual([]);
  });

  it("survives a realistic paste-then-type-then-backspace sequence", () => {
    const pasted = "z".repeat(10);
    let cur = `ab${pasted}cd`;
    let live: PasteSpan[] = [{ start: 2, end: 12 }];

    const typed = `ab${pasted}cdX`;
    live = applyEditToSpans(live, cur, typed);
    cur = typed;
    expect(live).toEqual([{ start: 2, end: 12 }]);

    const undone = `ab${pasted}cd`;
    live = applyEditToSpans(live, cur, undone);
    expect(live).toEqual([{ start: 2, end: 12 }]);
    expect(collapseForDisplay(undone, undone.length, live).text)
      .toBe("ab[pasted 10 chars]cd");
  });
});

describe("clampSpans", () => {
  it("drops spans that fall outside the text", () => {
    expect(clampSpans([{ start: 0, end: 5 }, { start: 90, end: 99 }], 10))
      .toEqual([{ start: 0, end: 5 }]);
  });

  it("drops empty or inverted spans", () => {
    expect(clampSpans([{ start: 4, end: 4 }, { start: 6, end: 2 }], 10)).toEqual([]);
  });
});
