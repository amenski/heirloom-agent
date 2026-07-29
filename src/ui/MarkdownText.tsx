import React from "react";
import { Text } from "ink";

type Format = "bold" | "italic" | "code" | "strike";

interface Segment {
  text: string;
  formats: Format[];
}

/** ANSI dim/bold wrappers (caller controls NO_COLOR). */
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/**
 * Parse a string with inline formatting into segments.
 * Supports: **bold**, *italic*, `code`, ~~strike~~, [text](url)
 */
function parseInline(input: string): Segment[] {
  // Normalize links before pattern matching
  const normalized = input.replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)");

  const patterns: { regex: RegExp; format: Format }[] = [
    { regex: /\*\*(.+?)\*\*/g, format: "bold" },
    { regex: /~~(.+?)~~/g, format: "strike" },
    { regex: /`(.+?)`/g, format: "code" },
    { regex: /\*(.+?)\*/g, format: "italic" },
  ];

  interface Match {
    start: number;
    end: number;
    text: string;
    format: Format;
  }

  const matches: Match[] = [];

  for (const { regex, format } of patterns) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(normalized)) !== null) {
      const overlaps = matches.some(
        (existing) => m!.index < existing.end && existing.start < m!.index + m![0].length,
      );
      if (!overlaps) {
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          text: m[1],
          format,
        });
      }
    }
  }

  matches.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let pos = 0;

  for (const match of matches) {
    if (match.start > pos) {
      segments.push({ text: normalized.slice(pos, match.start), formats: [] });
    }
    segments.push({ text: match.text, formats: [match.format] });
    pos = match.end;
  }

  if (pos < normalized.length) {
    segments.push({ text: normalized.slice(pos), formats: [] });
  }

  if (segments.length === 0) {
    segments.push({ text: normalized, formats: [] });
  }

  return segments;
}

/** Render a single segment with Ink Text props. */
function SegmentText({ segment }: { segment: Segment }) {
  const props: Record<string, any> = {};

  if (segment.formats.includes("bold")) props.bold = true;
  if (segment.formats.includes("italic")) props.italic = true;
  if (segment.formats.includes("strike")) props.strikethrough = true;
  if (segment.formats.includes("code")) {
    props.dimColor = true;
  }

  return <Text {...props}>{segment.text}</Text>;
}

/**
 * Render a multi-line fenced code block.
 * Receives the full block including ``` fences as a single string.
 */
function CodeBlockBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const lang = lines[0].length > 3 ? lines[0].slice(3).trim() : "";
  // Exclude the closing fence if present
  const content = lines.slice(1, lines[lines.length - 1] === "```" ? -1 : undefined);
  const header = lang ? `  ── ${lang} ──` : "  ── code ──";
  const body = content.map((l) => `  ${l}`).join("\n");

  return <Text dimColor>{dim(header)}{"\n"}{dim(body)}</Text>;
}

/**
 * Main Markdown renderer.
 *
 * Detects block-level constructs (fenced code blocks, headings, blockquotes,
 * lists, horizontal rules) and falls back to inline formatting.
 */
export default function MarkdownText({ children }: { children: string }) {
  const text = children;

  // ── Fenced code block (multi-line, starts with ```) ──
  if (text.startsWith("```") && text.includes("\n")) {
    return <CodeBlockBlock text={text} />;
  }

  // ── Code fence opener alone (no content yet) ──
  if (text.startsWith("```")) {
    const lang = text.length > 3 ? text.slice(3).trim() : "";
    return <Text dimColor>{dim(lang ? `  ── ${lang} ──` : "  ── code ──")}</Text>;
  }

  // ── Heading: #, ##, ###, etc. ──
  const headingMatch = text.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    const content = headingMatch[2];
    return <Text bold={level <= 3}>{content}</Text>;
  }

  // ── Horizontal rule: ---, ***, ___ (3+ chars) ──
  if (/^[-*_]{3,}$/.test(text.trim())) {
    return <Text dimColor>{dim("─".repeat(48))}</Text>;
  }

  // ── Blockquote: > text ──
  if (text.startsWith("> ")) {
    const segs = parseInline(text.slice(2));
    return (
      <Text>
        <Text dimColor>{dim("▎")}</Text>
        {" "}
        {segs.map((seg, i) => (
          <SegmentText key={i} segment={seg} />
        ))}
      </Text>
    );
  }

  // ── Unordered list: "- text" or "* text" (but not "**bold**") ──
  const ulMatch = text.match(/^([-*])\s+(.+)$/);
  if (ulMatch && !text.startsWith("**")) {
    const segs = parseInline(ulMatch[2]);
    return (
      <Text>
        <Text dimColor>{dim(" •")}</Text>
        {" "}
        {segs.map((seg, i) => (
          <SegmentText key={i} segment={seg} />
        ))}
      </Text>
    );
  }

  // ── Ordered list: 1. text, 2. text, etc. ──
  const olMatch = text.match(/^(\d+)\.\s+(.+)$/);
  if (olMatch) {
    const num = olMatch[1];
    const segs = parseInline(olMatch[2]);
    return (
      <Text>
        <Text dimColor>{dim(` ${num}.`)}</Text>
        {" "}
        {segs.map((seg, i) => (
          <SegmentText key={i} segment={seg} />
        ))}
      </Text>
    );
  }

  // ── Default: inline formatting only ──
  const segments = parseInline(text);
  return (
    <Text>
      {segments.map((seg, i) => (
        <SegmentText key={i} segment={seg} />
      ))}
    </Text>
  );
}
