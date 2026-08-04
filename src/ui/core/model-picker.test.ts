import { describe, it, expect } from "vitest";
import {
  matchEntry,
  buildRows,
  selectableIndices,
  moveSelection,
  formatContext,
} from "./model-picker.js";
import type { ModelEntry } from "../types.js";

const entries: ModelEntry[] = [
  { provider: "deepseek", model: "deepseek-v4-pro", contextWindow: 1000000 },
  { provider: "deepseek", model: "deepseek-v4-flash", contextWindow: 1000000 },
  { provider: "openai", model: "gpt-5.6-sol", contextWindow: 256000 },
  { provider: "groq", model: "llama-3.3-70b-versatile", contextWindow: 128000 },
];

describe("matchEntry", () => {
  it("matches against the provider half of provider/model", () => {
    const e = entries[2]; // openai/gpt-5.6-sol
    expect(matchEntry(e, "openai")).not.toBeNull();
  });

  it("matches against the model name", () => {
    expect(matchEntry(entries[3], "llama")).not.toBeNull();
  });

  it("rejects a query that matches neither", () => {
    expect(matchEntry(entries[3], "anthropic")).toBeNull();
  });
});

describe("buildRows", () => {
  it("groups models under one header per provider", () => {
    const rows = buildRows({ entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro" });
    const headers = rows.filter((r) => r.kind === "header");
    expect(headers.map((h) => h.provider)).toEqual(["deepseek", "openai", "groq"]);
  });

  it("drops a provider's header when none of its models match", () => {
    const rows = buildRows({ entries, query: "llama", currentProvider: "deepseek", currentModel: "deepseek-v4-pro" });
    expect(rows.filter((r) => r.kind === "header").map((h) => h.provider)).toEqual(["groq"]);
    expect(rows.filter((r) => r.kind === "model")).toHaveLength(1);
  });

  it("flags exactly the row matching BOTH provider and model as current", () => {
    const rows = buildRows({ entries, query: "", currentProvider: "openai", currentModel: "gpt-5.6-sol" });
    const current = rows.filter((r) => r.kind === "model" && r.current);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ provider: "openai", model: "gpt-5.6-sol" });
  });

  it("marks models whose provider has no key as unconfigured", () => {
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro",
      configured: { deepseek: true, openai: false, groq: false },
    });
    const sol = rows.find((r) => r.kind === "model" && r.model === "gpt-5.6-sol");
    const pro = rows.find((r) => r.kind === "model" && r.model === "deepseek-v4-pro");
    expect(sol).toMatchObject({ configured: false });
    expect(pro).toMatchObject({ configured: true });
  });

  it("treats every provider as configured when no map is supplied", () => {
    const rows = buildRows({ entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro" });
    expect(rows.filter((r) => r.kind === "model" && !r.configured)).toHaveLength(0);
  });

  it("uses display labels for headers when provided", () => {
    const rows = buildRows({
      entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro",
      labels: { deepseek: "DeepSeek" },
    });
    expect(rows.find((r) => r.kind === "header" && r.provider === "deepseek")).toMatchObject({ label: "DeepSeek" });
    // Falls back to the raw name when unlabeled.
    expect(rows.find((r) => r.kind === "header" && r.provider === "groq")).toMatchObject({ label: "groq" });
  });

  it("returns no rows when nothing matches", () => {
    expect(buildRows({ entries, query: "zzzz", currentProvider: "deepseek" })).toEqual([]);
  });
});

describe("navigation skips headers", () => {
  const rows = buildRows({ entries, query: "", currentProvider: "deepseek", currentModel: "deepseek-v4-pro" });

  it("only model rows are selectable", () => {
    const idx = selectableIndices(rows);
    expect(idx).toHaveLength(4);
    for (const i of idx) expect(rows[i].kind).toBe("model");
  });

  it("moving down never lands on a header", () => {
    let cur = selectableIndices(rows)[0];
    for (let n = 0; n < 8; n++) {
      cur = moveSelection(rows, cur, 1);
      expect(rows[cur].kind).toBe("model");
    }
  });

  it("wraps around at both ends", () => {
    const idx = selectableIndices(rows);
    expect(moveSelection(rows, idx[idx.length - 1], 1)).toBe(idx[0]);
    expect(moveSelection(rows, idx[0], -1)).toBe(idx[idx.length - 1]);
  });

  it("returns -1 when there is nothing to select", () => {
    expect(moveSelection([], 0, 1)).toBe(-1);
  });
});

describe("formatContext", () => {
  it("renders a context window in thousands", () => {
    expect(formatContext(1000000)).toBe("1000k ctx");
    expect(formatContext(128000)).toBe("128k ctx");
  });

  it("renders nothing when unknown", () => {
    expect(formatContext(undefined)).toBe("");
  });
});
