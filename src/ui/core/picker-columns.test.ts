import { describe, it, expect } from "vitest";
import { computeColumns, fit, fitRight, COLUMN_GAP, STATE_WIDTH } from "./picker-columns.js";

const ROWS = [
  { label: "DeepSeek V4 Flash", providerLabel: "DeepSeek", ctx: "1000k ctx" },
  { label: "GPT-5.6 Sol", providerLabel: "OpenAI", ctx: "256k ctx" },
  { label: "Llama 3.3 70B Versatile", providerLabel: "Groq", ctx: "128k ctx" },
];

describe("computeColumns", () => {
  it("sizes provider and ctx to their widest value", () => {
    const c = computeColumns(ROWS, 80);
    expect(c.provider).toBe("DeepSeek".length);
    expect(c.ctx).toBe("1000k ctx".length);
  });

  it("gives the label column the leftover width", () => {
    const available = 80;
    const c = computeColumns(ROWS, available);
    const used = c.label + c.provider + c.ctx + STATE_WIDTH + COLUMN_GAP * 3;
    expect(used).toBe(available);
  });

  it("keeps columns identical across rows so they line up", () => {
    // The whole point: widths come from the row SET, not each row.
    const c1 = computeColumns(ROWS, 80);
    const c2 = computeColumns([...ROWS].reverse(), 80);
    expect(c2).toEqual(c1);
  });

  it("shrinks the label column rather than the status fields when tight", () => {
    const wide = computeColumns(ROWS, 80);
    const narrow = computeColumns(ROWS, 50);
    expect(narrow.label).toBeLessThan(wide.label);
    expect(narrow.provider).toBe(wide.provider);
    expect(narrow.ctx).toBe(wide.ctx);
  });

  it("never collapses the label column below a readable minimum", () => {
    expect(computeColumns(ROWS, 10).label).toBeGreaterThanOrEqual(8);
  });

  it("handles rows with no provider or ctx", () => {
    const c = computeColumns([{ label: "Llama 3.2" }], 60);
    expect(c.provider).toBe(0);
    expect(c.ctx).toBe(0);
  });
});

describe("fit", () => {
  it("pads a short string to exactly the width", () => {
    expect(fit("abc", 6)).toBe("abc   ");
  });

  it("leaves an exact-width string untouched", () => {
    expect(fit("abcdef", 6)).toBe("abcdef");
  });

  it("truncates with an ellipsis, keeping the identifying start", () => {
    expect(fit("DeepSeek V4 Flash", 8)).toBe("DeepSee…");
    expect(fit("DeepSeek V4 Flash", 8)).toHaveLength(8);
  });

  it("degrades to a bare ellipsis at width 1", () => {
    expect(fit("anything", 1)).toBe("…");
  });

  it("returns empty at zero or negative width", () => {
    expect(fit("abc", 0)).toBe("");
    expect(fit("abc", -3)).toBe("");
  });
});

describe("fitRight", () => {
  it("right-aligns within the width", () => {
    expect(fitRight("256k", 9)).toBe("     256k");
  });

  it("keeps the tail when the text overflows", () => {
    expect(fitRight("1000k ctx", 4)).toBe(" ctx");
  });
});
