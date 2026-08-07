import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import MarkdownText from "./MarkdownText.js";
import { stripAnsi } from "./test-helpers.js";

describe("MarkdownText block rendering", () => {
  it("parses inline formatting inside headings", () => {
    const md = "# **Bold** plan";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const frame = stripAnsi(lastFrame() ?? "");
    // The heading marker and the emphasis markers must not leak through.
    expect(frame).not.toContain("#");
    expect(frame).not.toContain("**");
    expect(frame).toContain("Bold plan");
  });

  it("renders a span that closes across a newline (paragraph merge)", () => {
    // flushPendingParagraph commits held lines joined with "\n" as one entry,
    // so the renderer must parse bold/code spanning the newline.
    const md = "**bold\ncontinues**";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("**");
    expect(frame).toContain("bold");
    expect(frame).toContain("continues");
  });
});
