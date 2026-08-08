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

  it("renders a wrapped unordered list item as one bullet with its continuation", () => {
    // The streamer commits a held list block as a single "\n"-joined entry.
    const md = "- first item\n  wrapped under it\n- second item";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const frame = stripAnsi(lastFrame() ?? "");
    // Continuation lines stay under the bullet, not re-bulleted.
    expect(frame).toContain("first item");
    expect(frame).toContain("wrapped under it");
    expect(frame).toContain("second item");
    const bullets = frame.split("\n").filter((l) => l.includes("•")).length;
    expect(bullets).toBe(2);
  });

  it("renders a wrapped ordered list item with its own number", () => {
    const md = "1. first\n   continuation\n2. second";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("first");
    expect(frame).toContain("continuation");
    expect(frame).toContain("second");
    expect(frame).toMatch(/1\./);
    expect(frame).toMatch(/2\./);
  });

  it("renders a multi-line blockquote with a ▎ marker per line", () => {
    const md = "> line one\n> line two";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    // Both lines carry the marker, and the raw ">" never leaks.
    expect(frame.split("\n").filter((l) => l.includes("▎")).length).toBe(2);
    expect(frame).not.toContain("> line");
  });
});
