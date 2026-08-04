import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import SkillList from "./SkillList.js";
import type { SkillDef } from "../../skills/index.js";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const skill = (name: string, description: string): SkillDef => ({
  name,
  description,
  content: "",
  sourcePath: `/skills/${name}`,
});

const skills: SkillDef[] = [
  skill("commit", "Commit changes in this agent context"),
  skill("review", "Review a GitHub pull request"),
  skill("dataviz", "Create a chart or data visualization"),
];

describe("SkillList", () => {
  it("renders without crashing given a few skills", () => {
    const { lastFrame } = render(
      <SkillList skills={skills} onSelect={vi.fn()} onClose={vi.fn()} width={80} height={24} />,
    );
    expect(lastFrame()).toBeTruthy();
  });

  it("renders each skill's name and description on separate lines (no wall-of-text)", () => {
    const { lastFrame } = render(
      <SkillList skills={skills} onSelect={vi.fn()} onClose={vi.fn()} width={80} height={24} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    const lines = frame.split("\n");

    for (const s of skills) {
      const nameLine = lines.find((l) => l.includes(s.name));
      expect(nameLine, `expected a line containing name "${s.name}"`).toBeDefined();

      const descLine = lines.find((l) => l.includes(s.description));
      expect(descLine, `expected a line containing description for "${s.name}"`).toBeDefined();

      // The anti-wall-of-text assertion: the name must NOT share its line with
      // the description (that's the bug from commit 594952c — "name —
      // description" wrapping into one unreadable block).
      expect(nameLine).not.toBe(descLine);
      expect(nameLine?.includes(s.description)).toBe(false);
    }
  });
});
