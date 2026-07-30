import { describe, it, expect } from "vitest";
import { parseInline } from "./MarkdownText.js";

function textOf(segments: { text: string }[]): string {
  return segments.map((s) => s.text).join("");
}

describe("parseInline", () => {
  it("renders **bold** once, without duplicated text (overlap regression)", () => {
    const segs = parseInline("I'm in **planning mode** right now");
    expect(textOf(segs)).toBe("I'm in planning mode right now");
    const bold = segs.find((s) => (s as any).formats.includes("bold"));
    expect(bold?.text).toBe("planning mode");
  });

  it("handles a short bold word", () => {
    const segs = parseInline("**No** file modifications");
    expect(textOf(segs)).toBe("No file modifications");
  });

  it("bold and italic coexist without overlap", () => {
    const segs = parseInline("**bold** and *italic* here");
    expect(textOf(segs)).toBe("bold and italic here");
  });

  it("code wins over bold inside backticks", () => {
    const segs = parseInline("`**not bold**` outside");
    expect(textOf(segs)).toBe("**not bold** outside");
    expect((segs[0] as any).formats).toContain("code");
  });
});
