import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ScopeChoicePrompt, ExternalScopeChoicePrompt } from "./PermissionPrompt.js";
import { stripAnsi } from "./test-helpers.js";
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

describe("ExternalScopeChoicePrompt", () => {
  it("offers folder-only vs subfolders for the external directory", () => {
    const { lastFrame } = render(
      <ExternalScopeChoicePrompt
        treePattern="/data/notes/**"
        cursor={0}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const frame = flatten(lastFrame() ?? "");
    expect(frame).toContain("This folder only");
    expect(frame).toContain("Include subfolders");
    expect(frame).toContain("/data/notes and everything beneath it");
    expect(frame).not.toContain("write access");
  });

  it("abbreviates the home directory in the covered path", () => {
    const home = process.env.HOME;
    if (!home) return;
    const { lastFrame } = render(
      <ExternalScopeChoicePrompt
        treePattern={`${home}/SecondBrain/AgentMemory/**`}
        cursor={1}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const frame = flatten(lastFrame() ?? "");
    expect(frame).toContain("~/SecondBrain/AgentMemory and everything beneath it");
    expect(frame).toContain("> 2. Include subfolders");
  });
});
