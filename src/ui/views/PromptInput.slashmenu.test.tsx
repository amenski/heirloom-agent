import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import PromptInput, { type PromptSubmission } from "./PromptInput.js";
import { __resetInputWireForTests } from "../hooks/useTerminalInput.js";
import { stripAnsi } from "../test-helpers.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RETURN = "\r";

const flush = () => new Promise((r) => setTimeout(r, 60));

/**
 * Slash menu Enter-to-select. Regression context: cca65ad made Enter fall
 * through to submit the buffer so args survived ("/raw normal"), but that left
 * a bare "/" submitting as text — App answered "Unknown: /". Enter must select
 * the highlighted command when the buffer holds only the slash token, and keep
 * submitting the whole line when args are present.
 */
const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

function setup() {
  const onSubmit = vi.fn<(s: PromptSubmission) => void>();
  const onModelPickerOpen = vi.fn();
  const inst = render(
    <PromptInput
      onSubmit={onSubmit}
      onModelPickerOpen={onModelPickerOpen}
      screenWidth={80}
      promptHistory={[]}
      busy={false}
    />,
  );
  mounted.push(inst);
  return { ...inst, onSubmit, onModelPickerOpen };
}

describe("PromptInput slash menu Enter-to-select", () => {
  it("Enter on a bare / selects the highlighted (first) command", async () => {
    const { stdin, onSubmit } = setup();
    stdin.write("/");
    await flush();
    stdin.write(RETURN);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({ text: "/skills" });
  });

  it("Down then Enter selects the highlighted command, not the raw slash", async () => {
    const { stdin, onSubmit, onModelPickerOpen } = setup();
    stdin.write("/");
    await flush();
    stdin.write(DOWN);
    await flush();
    stdin.write(RETURN);
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onModelPickerOpen).toHaveBeenCalledTimes(1);
  });

  it("Enter with args after the token submits the whole line", async () => {
    const { stdin, onSubmit } = setup();
    stdin.write("/raw normal");
    await flush();
    stdin.write(RETURN);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({ text: "/raw normal" });
  });

  it("selecting via Enter clears the buffer", async () => {
    const { stdin, lastFrame, onSubmit } = setup();
    stdin.write("/clear");
    await flush();
    stdin.write(RETURN);
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({ text: "/clear" });
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("/clear");
  });

  it("the menu shows navigation hint and moves the highlight on Down", async () => {
    const { stdin, lastFrame } = setup();
    stdin.write("/");
    await flush();
    let frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Enter select");
    expect(frame).toMatch(/1\/16/);
    stdin.write(DOWN);
    await flush();
    frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toMatch(/2\/16/);
  });
});
