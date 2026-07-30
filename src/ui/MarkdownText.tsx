/**
 * Heirloom MarkdownText — Rich markdown renderer with syntax highlighting
 *
 * Features:
 * - Inline formatting: **bold**, *italic*, `code`, ~~strike~~, [links](url)
 * - Block elements: headings, blockquotes, lists, horizontal rules
 * - Fenced code blocks with syntax highlighting (10+ languages)
 * - Theme-aware colors via ThemeContextValue
 * - Graceful fallback when syntax highlighter unavailable
 */

import React from "react";
import { Text } from "ink";
import SyntaxHighlighter, { detectLanguage, type Language } from "./SyntaxHighlighter.js";

// ── Types ──

type Format = "bold" | "italic" | "code" | "strike";

interface Segment {
  text: string;
  formats: Format[];
}

interface MarkdownTextProps {
  children: string;
  /** Optional theme context for syntax highlighting and colors */
  theme?: {
    colorEnabled: boolean;
    theme: {
      syntax: any;
      text: number;
      textDim: number;
      textBright: number;
      textInverse: number;
    };
    syntax: (key: string, text: string) => string;
    dim: (text: string) => string;
    fg: (color: number, text: string) => string;
  };
}

// ── Inline Parser ──

/**
 * Parse inline markdown formatting into segments.
 * Supports: **bold**, *italic*, `code`, ~~strike~~, [text](url)
 * Priority: code > bold > italic > strike (code wins overlaps)
 */
function parseInline(input: string): Segment[] {
  // Normalize links before pattern matching: [text](url) → text (url)
  const normalized = input.replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)");

  const patterns: { regex: RegExp; format: Format }[] = [
    { regex: /`(.+?)`/g, format: "code" },
    { regex: /\*\*(.+?)\*\*/g, format: "bold" },
    { regex: /\*(.+?)\*/g, format: "italic" },
    { regex: /~~(.+?)~~/g, format: "strike" },
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
      // Check for overlap with higher-priority matches (code)
      const overlaps = matches.some(
        (existing) =>
          (existing.format === "code" || format === "code") &&
          m!.index < existing.end &&
          existing.start < m!.index + m![0].length,
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

// ── Inline Segment Renderer ──

function SegmentText({ segment, theme }: { segment: Segment; theme?: MarkdownTextProps["theme"] }) {
  const props: Record<string, any> = {};

  if (segment.formats.includes("bold")) props.bold = true;
  if (segment.formats.includes("italic")) props.italic = true;
  if (segment.formats.includes("strike")) props.strikethrough = true;

  return <Text {...props}>{segment.text}</Text>;
}

// ── Code Block Renderer (with Syntax Highlighting) ──

function CodeBlockBlock({
  text,
  theme,
}: {
  text: string;
  theme?: MarkdownTextProps["theme"];
}) {
  const lines = text.split("\n");
  const info = lines[0].length > 3 ? lines[0].slice(3).trim() : "";
  // Exclude closing fence
  const content = lines.slice(1, lines[lines.length - 1] === "```" ? -1 : undefined);

  const language = detectLanguage(info);
  const langLabel = language !== "text" ? language : (info || "code");

  const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
  const fg = theme?.fg;

  if (!theme || !theme.colorEnabled || language === "text") {
    // Fallback: plain dim text
    const header = dim(`  ── ${langLabel} ──`);
    const body = content.map((l) => dim(`  ${l}`)).join("\n");
    return <Text>{header}{"\n"}{body}</Text>;
  }

  // Use syntax highlighting
  const joinedCode = content.join("\n");

  return (
    <Text>
      <Text dimColor>{dim(`  ── ${langLabel} ──`)}</Text>
      {"\n"}
      {content.length > 0 && (
        <SyntaxHighlighter
          code={joinedCode}
          language={language}
          theme={theme as any}
        />
      )}
    </Text>
  );
}

// ── Main Markdown Renderer ──

function MarkdownText({ children, theme }: MarkdownTextProps) {
  const text = children;

  if (!text) return null;

  // ── Fenced code block (multi-line, starts with ```) ──
  if (text.startsWith("```") && text.includes("\n")) {
    return <CodeBlockBlock text={text} theme={theme} />;
  }

  // ── Code fence opener alone (no content yet — streaming) ──
  if (text.startsWith("```")) {
    const lang = text.length > 3 ? text.slice(3).trim() : "";
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return <Text dimColor>{dim(lang ? `  ── ${lang} ──` : "  ── code ──")}</Text>;
  }

  // ── Heading: #, ##, ###, etc. ──
  const headingMatch = text.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    const content = headingMatch[2];
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    if (level <= 2) {
      // H1/H2 with underline-style emphasis
      return (
        <Text>
          <Text bold>{content}</Text>
        </Text>
      );
    }
    return <Text bold={level <= 3}>{content}</Text>;
  }

  // ── Horizontal rule: ---, ***, ___ (3+ chars) ──
  if (/^[-*_]{3,}$/.test(text.trim())) {
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return <Text dimColor>{dim("─".repeat(48))}</Text>;
  }

  // ── Blockquote: > text ──
  if (text.startsWith("> ")) {
    const segs = parseInline(text.slice(2));
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return (
      <Text>
        <Text dimColor>{dim("▎")}</Text>{" "}
        {segs.map((seg, i) => (
          <SegmentText key={i} segment={seg} theme={theme} />
        ))}
      </Text>
    );
  }

  // ── Unordered list: "- text" or "* text" (but not "**bold**") ──
  const ulMatch = text.match(/^([-*])\s+(.+)$/);
  if (ulMatch && !text.startsWith("**")) {
    const segs = parseInline(ulMatch[2]);
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return (
      <Text>
        <Text dimColor>{dim(" •")}</Text>{" "}
        {segs.map((seg, i) => (
          <SegmentText key={i} segment={seg} theme={theme} />
        ))}
      </Text>
    );
  }

  // ── Ordered list: 1. text, 2. text, etc. ──
  const olMatch = text.match(/^(\d+)\.\s+(.+)$/);
  if (olMatch) {
    const num = olMatch[1];
    const segs = parseInline(olMatch[2]);
    const dim = theme?.dim ?? ((s: string) => `\x1b[2m${s}\x1b[0m`);
    return (
      <Text>
        <Text dimColor>{dim(` ${num}.`)}</Text>{" "}
        {segs.map((seg, i) => (
          <SegmentText key={i} segment={seg} theme={theme} />
        ))}
      </Text>
    );
  }

  // ── Default: inline formatting only ──
  const segments = parseInline(text);
  return (
    <Text>
      {segments.map((seg, i) => (
        <SegmentText key={i} segment={seg} theme={theme} />
      ))}
    </Text>
  );
}

export default React.memo(MarkdownText);
