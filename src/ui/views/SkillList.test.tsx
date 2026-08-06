import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import SkillList from "./SkillList.js";
import type { SkillDef } from "../../skills/index.js";
import { __resetInputWireForTests } from "../hooks/useTerminalInput.js";

const ESC = "\x1b";
const ENTER = "\r";

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

// useTerminalInput keeps ONE module-level stdin listener for the process, so a
// component left mounted from a previous test keeps ownership of the wire and
// the next render's keys go nowhere. Unmount and reset between tests.
const mounted: Array<{ unmount: () => void }> = [];
// Ink batches fast keypresses into a re-render; 25ms was flaky, 60ms settles.
const flush = () => new Promise((r) => setTimeout(r, 60));

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

function setup(onSelect = vi.fn(), onClose = vi.fn()) {
  const inst = render(
    <SkillList skills={skills} onSelect={onSelect} onClose={onClose} width={80} height={24} />,
  );
  mounted.push(inst);
  return inst;
}

describe("SkillList", () => {
  it("renders without crashing given a few skills", () => {
    const { lastFrame } = setup();
    expect(lastFrame()).toBeTruthy();
  });

  it("renders each skill on one row without wrapping into a wall of text", () => {
    // Regression context (594952c): descriptions used to wrap into a block
    // that merged every skill into unreadable prose. The fix at the time was
    // to put the description on its own indented line — but skill
    // descriptions are paragraphs (median 327 chars), so that cost 7-11 rows
    // EACH and only ~2 skills fit on a 24-row terminal.
    //
    // Now name and description share ONE row in aligned columns, with the
    // description truncated. The property that matters is unchanged: no skill
    // may span multiple rows, and text must never wrap.
    const { lastFrame } = setup();
    const lines = stripAnsi(lastFrame() ?? "").split("\n");

    for (const s of skills) {
      const matching = lines.filter((l) => l.includes(s.name));
      expect(matching, `expected exactly one row for "${s.name}"`).toHaveLength(1);
    }
  });

  it("typing filters the list", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("commit");
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("commit");
    expect(frame).not.toContain("review");
    expect(frame).not.toContain("dataviz");
  });

  it("handles a multi-character chunk written in a single stdin.write (fast typing / paste)", async () => {
    const { stdin, lastFrame } = setup();
    // Regression for the length === 1 gate: Ink delivers fast typing or a
    // paste as one multi-char chunk, and a naive "only accept length 1"
    // check silently drops it.
    stdin.write("clean");
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain('matching "clean"');
    expect(frame).toContain("Search: clean");
  });

  it("fuzzy-matches non-adjacent characters", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("dtvz"); // d-a-t-a-v-i-z: non-adjacent subsequence of "dataviz"
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("dataviz");
    expect(frame).not.toContain("commit");
    expect(frame).not.toContain("review");
  });

  it("matches on description alone", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("GitHub"); // only "review"'s description mentions GitHub
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("review");
    expect(frame).not.toContain("commit");
    expect(frame).not.toContain("dataviz");
  });

  it("backspace narrows then widens the results", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("co");
    await flush();
    let frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("commit");
    expect(frame).not.toContain("review");

    stdin.write("mmit-x");
    await flush();
    frame = stripAnsi(lastFrame() ?? "");
    // "commit-x" no longer matches any skill.
    expect(frame).toContain("No skills match.");

    stdin.write("\x7f"); // backspace
    await flush();
    frame = stripAnsi(lastFrame() ?? "");
    // Back to "commit-", still no match.
    expect(frame).toContain("No skills match.");
  });

  it("Esc clears an active search first, then closes", async () => {
    const onClose = vi.fn();
    const { stdin, lastFrame } = setup(vi.fn(), onClose);
    stdin.write("commit");
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("review");

    stdin.write(ESC);
    await flush();
    // Search cleared: the full list is back and the picker is still open.
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("review");
    expect(frame).toContain("dataviz");
    expect(onClose).not.toHaveBeenCalled();

    stdin.write(ESC);
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter selects the highlighted (filtered) skill", async () => {
    const onSelect = vi.fn();
    const { stdin } = setup(onSelect);
    stdin.write("dataviz");
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSelect).toHaveBeenCalledWith("dataviz");
  });
});
