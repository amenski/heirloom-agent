import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ScopeChoicePrompt } from "./PermissionPrompt.js";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
// Collapses the rendered frame to a single space-joined line, stripping the
// box-drawing border chars too — long sentences wrap inside the bordered box
// and the border glyphs sit flush against the text, so a plain whitespace
// collapse alone can still glue words from adjacent wrapped lines together.
const flatten = (s: string) => stripAnsi(s).replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ").trim();

describe("ScopeChoicePrompt", () => {
  it("uses read-flavored copy for a read tool", () => {
    const { lastFrame } = render(
      <ScopeChoicePrompt
        folderPattern="./src/**"
        toolName="read_file"
        cursor={0}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Whole folder covers ./src and everything beneath it.");
    expect(frame).not.toContain("write access");
  });

  it("warns about recursive write access for a write tool", () => {
    const { lastFrame } = render(
      <ScopeChoicePrompt
        folderPattern="./src/**"
        toolName="write_to_file"
        cursor={0}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const frame = flatten(lastFrame() ?? "");
    expect(frame).toContain("write access to ./src");
    expect(frame).toContain("modify or overwrite any file there");
  });

  it("warns about recursive write access for an edit-family tool", () => {
    const { lastFrame } = render(
      <ScopeChoicePrompt
        folderPattern="./lib/**"
        toolName="apply_patch"
        cursor={0}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("write access to ./lib");
  });
});
