import { describe, it, expect } from "vitest";
import {
  formatSubagentHeader,
  formatSubagentToolLine,
  formatSubagentFinishLine,
  initSubagentDisplayState,
  MAX_VISIBLE_CHILDREN,
  type SubagentDisplayState,
} from "./subagent-progress-format.js";

describe("formatSubagentHeader", () => {
  it("renders the description, model, and no agent suffix for an unnamed sub-agent", () => {
    expect(
      formatSubagentHeader({ description: "review the auth module", model: "Sonnet 5", depth: 0 }),
    ).toBe("⏺ Agent(review the auth module) Sonnet 5");
  });

  it("appends the defined agent name when the task ran as one", () => {
    expect(
      formatSubagentHeader({
        description: "review the auth module",
        agentName: "reviewer",
        model: "Sonnet 5",
        depth: 0,
      }),
    ).toBe("⏺ Agent(review the auth module) Sonnet 5 (reviewer)");
  });

  it("omits the model suffix when no model is known", () => {
    expect(formatSubagentHeader({ description: "do it", depth: 0 })).toBe("⏺ Agent(do it)");
  });

  it("indents by depth, two spaces per level", () => {
    expect(formatSubagentHeader({ description: "nested", depth: 2 })).toBe(
      "    ⏺ Agent(nested)",
    );
  });
});

describe("formatSubagentToolLine", () => {
  it("renders the first tool call as a nested tree line under the header", () => {
    const state = initSubagentDisplayState();
    const line = formatSubagentToolLine(state, "read_file", { path: "src/a.ts" }, 0);
    expect(line).toBe("  └ Read(src/a.ts)");
    expect(state.shownCount).toBe(1);
    expect(state.totalCount).toBe(1);
  });

  it("indents one level deeper than the header at the same depth", () => {
    const state = initSubagentDisplayState();
    const headerDepth = 1;
    const line = formatSubagentToolLine(state, "read_file", { path: "a.ts" }, headerDepth);
    // header at depth 1 -> "  ⏺ Agent(...)"; child one level deeper -> "    └ ..."
    expect(line?.startsWith("    └")).toBe(true);
  });

  it("reuses describeToolCall's arg formatting (run_bash truncates and shows the command)", () => {
    const state = initSubagentDisplayState();
    const line = formatSubagentToolLine(state, "run_bash", { command: "grep -n foo src/x.ts" }, 0);
    expect(line).toBe('  └ Bash(grep -n foo src/x.ts)');
  });

  it("prints every child up to MAX_VISIBLE_CHILDREN, then collapses to a single rollup line", () => {
    const state = initSubagentDisplayState();
    const lines: (string | null)[] = [];
    for (let i = 0; i < MAX_VISIBLE_CHILDREN + 5; i++) {
      lines.push(formatSubagentToolLine(state, "read_file", { path: `f${i}.ts` }, 0));
    }
    const shown = lines.slice(0, MAX_VISIBLE_CHILDREN);
    expect(shown.every((l) => l !== null)).toBe(true);
    // The (MAX_VISIBLE_CHILDREN + 1)-th call prints the rollup line instead of a detail line.
    expect(lines[MAX_VISIBLE_CHILDREN]).toBe("  … +1 tool use");
    // Further calls beyond that fold silently — no new line, no reprint.
    for (let i = MAX_VISIBLE_CHILDREN + 1; i < lines.length; i++) {
      expect(lines[i]).toBeNull();
    }
    expect(state.totalCount).toBe(MAX_VISIBLE_CHILDREN + 5);
  });

  it("pluralizes the rollup count correctly", () => {
    const state: SubagentDisplayState = {
      shownCount: MAX_VISIBLE_CHILDREN,
      totalCount: MAX_VISIBLE_CHILDREN,
      rollupPrinted: false,
    };
    // Exactly one hidden call.
    const line = formatSubagentToolLine(state, "read_file", { path: "x.ts" }, 0);
    expect(line).toBe("  … +1 tool use");
  });

  it("tracks totalCount across the visible/hidden boundary for the hidden-count math", () => {
    const state = initSubagentDisplayState();
    for (let i = 0; i < MAX_VISIBLE_CHILDREN; i++) {
      formatSubagentToolLine(state, "read_file", { path: `f${i}.ts` }, 0);
    }
    const rollup = formatSubagentToolLine(state, "read_file", { path: "extra1.ts" }, 0);
    const rollup2 = formatSubagentToolLine(state, "read_file", { path: "extra2.ts" }, 0);
    expect(rollup).toBe("  … +1 tool use");
    // Second hidden call doesn't reprint (Static can't rewrite the rollup line).
    expect(rollup2).toBeNull();
  });
});

describe("formatSubagentFinishLine", () => {
  it("renders seconds under a minute", () => {
    expect(formatSubagentFinishLine({ depth: 0, elapsedMs: 45_000 })).toBe(
      "  └ sub-agent finished · 45s",
    );
  });

  it("renders minutes and seconds at/over a minute", () => {
    expect(formatSubagentFinishLine({ depth: 0, elapsedMs: 73_000 })).toBe(
      "  └ sub-agent finished · 1m 13s",
    );
  });

  it("indents one level deeper than the header at the same depth", () => {
    expect(formatSubagentFinishLine({ depth: 1, elapsedMs: 1000 })).toBe(
      "    └ sub-agent finished · 1s",
    );
  });
});
