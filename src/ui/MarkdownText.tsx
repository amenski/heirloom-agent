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
import MarkdownTable, { isTableBlock } from "./MarkdownTable.js";

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
 * Supports: **bold**, *italic*, _italic_, ***bold italic***, `code`, ~~strike~~,
 * [text](url) → "text (url)".
 *
 * Unclosed delimiters degrade to literal text (**unclosed → "**unclosed").
 * The tree building lives in scanInline (see there for nesting and flanking).
 */
export function parseInline(input: string): Segment[] {
  const { nodes, stack } = scanInline(input);

  // Unclosed openers at end-of-input: their markers were consumed at open
  // time, so restore them as literal text. The content between them stayed
  // as plain siblings, so **unclosed renders exactly "**unclosed".
  for (const d of stack) {
    nodes[d.nodeIndex] = { kind: "text", text: d.literal };
  }

  return flatten(nodes);
}

/**
 * True when `input` ends mid-span: an emphasis/strike opener (`**`, `*`,
 * `~~`) is still open, or a backtick run is unmatched. The streaming layer
 * (App.tsx) holds such a line back so the span can rejoin with its closer on
 * a later line. Reuses the parser's own flanking rules, so list bullets
 * ("* item"), arithmetic ("2 * 3 * 4") and snake_case ("foo_bar") never
 * false-positive. An odd total backtick count is OR'd in because an unclosed
 * code span degrades to literal backticks — it leaves no stack entry.
 */
export function inlineSpanOpen(input: string): boolean {
  if (scanInline(input).stack.length > 0) return true;
  const backticks = (input.match(/`/g) ?? []).length;
  return backticks % 2 === 1;
}

/**
 * Single left-to-right scan over a node tree with an opener stack, instead of
 * the old flat pattern scan that rejected any overlapping match:
 * - Code spans are atomic — their content is never scanned for emphasis or
 *   links, so `[x](y)` or ** inside backticks stays verbatim.
 * - Emphasis nests: **bold *italic* inside** wraps the inner span, and a code
 *   span inside bold picks up the bold format (**install `npm i -g x`**).
 * - ***both*** renders as bold+italic on one span.
 * - CommonMark-style flanking: `2 * 3 * 4` and `foo_bar_baz` stay literal,
 *   because a `*`/`_` between word characters can neither open nor close.
 */
function scanInline(input: string): { nodes: Node[]; stack: OpenDelim[] } {
  const nodes: Node[] = [];
  const stack: OpenDelim[] = [];
  const n = input.length;
  let i = 0;

  while (i < n) {
    const ch = input[i];

    // ── Code span: a backtick run of length k closes with the same-length
    // run. Content is atomic — never scanned for emphasis or links, so
    // `**bold**` or `[x](y)` inside backticks stays verbatim.
    if (ch === "`") {
      let run = 0;
      while (i + run < n && input[i + run] === "`") run++;
      const close = findBacktickClose(input, i + run, run);
      if (close !== -1) {
        nodes.push({ kind: "text", text: input.slice(i + run, close), code: true });
        i = close + run;
        continue;
      }
      nodes.push({ kind: "text", text: "`".repeat(run) });
      i += run;
      continue;
    }

    // ── Link: [text](url) → "text (url)". Only reached on non-code text,
    // because code spans were consumed atomically above.
    if (ch === "[") {
      const m = input.slice(i).match(/^\[([^\[\]]+)\]\(([^)\s]+)\)/);
      if (m) {
        nodes.push({ kind: "text", text: `${m[1]} (${m[2]})` });
        i += m[0].length;
        continue;
      }
    }

    // ── Emphasis / strike delimiter runs: *, _, ~ ──
    if (ch === "*" || ch === "_" || ch === "~") {
      let run = 0;
      while (i + run < n && input[i + run] === ch) run++;
      const prev = i > 0 ? input[i - 1] : "";
      const next = i + run < n ? input[i + run] : "";
      const leftFlanking =
        next !== "" &&
        !isWhitespace(next) &&
        (!isPunct(next) || prev === "" || isWhitespace(prev) || isPunct(prev));
      const rightFlanking =
        prev !== "" &&
        !isWhitespace(prev) &&
        (!isPunct(prev) || next === "" || isWhitespace(next) || isPunct(next));
      // A run that is both left- and right-flanking with no punctuation
      // involved (e.g. `_` in foo_bar_baz) can neither open nor close — the
      // CommonMark tie-break: both-flanking delimiters open only when preceded
      // by punctuation, close only when followed by it.
      const canOpen = leftFlanking && (!rightFlanking || isPunct(prev));
      const canClose = rightFlanking && (!leftFlanking || isPunct(next));

      let formats: Format[] | null = null;
      let delimCount = 0;
      if (ch === "~") {
        if (run >= 2) {
          formats = ["strike"];
          delimCount = 2;
        }
      } else if (run >= 3) {
        formats = ["bold", "italic"];
        delimCount = 3;
      } else if (run === 2) {
        formats = ["bold"];
        delimCount = 2;
      } else if (run === 1) {
        formats = ["italic"];
        delimCount = 1;
      }

      if (formats) {
        // Closing takes priority: match the innermost opener of the same char
        // and length (so **bold *italic* inside** closes italic before bold).
        if (canClose) {
          const k = findOpener(stack, ch, delimCount);
          if (k !== -1) {
            // Delimiters above the match never closed — restore their markers
            // as literal text instead of letting them vanish.
            for (let t = stack.length - 1; t > k; t--) {
              const d = stack[t];
              nodes[d.nodeIndex] = { kind: "text", text: d.literal };
            }
            const opener = stack[k];
            stack.length = k;
            opener.node.children = nodes.splice(opener.nodeIndex + 1);
            const leftover = run - delimCount;
            if (leftover > 0) nodes.push({ kind: "text", text: ch.repeat(leftover) });
            i += run;
            continue;
          }
        }
        if (canOpen) {
          const node: FmtNode = { kind: "fmt", formats, children: [] };
          nodes.push(node);
          stack.push({
            char: ch,
            count: delimCount,
            literal: ch.repeat(delimCount),
            nodeIndex: nodes.length - 1,
            node,
          });
          const leftover = run - delimCount;
          if (leftover > 0) nodes.push({ kind: "text", text: ch.repeat(leftover) });
          i += run;
          continue;
        }
      }

      nodes.push({ kind: "text", text: ch.repeat(run) });
      i += run;
      continue;
    }

    // ── Plain character ──
    nodes.push({ kind: "text", text: ch });
    i++;
  }

  return { nodes, stack };
}

// ── Parser helpers ──

type Node =
  | { kind: "text"; text: string; code?: boolean }
  | { kind: "fmt"; formats: Format[]; children: Node[] };

type FmtNode = Extract<Node, { kind: "fmt" }>;

interface OpenDelim {
  char: string;
  /** Run length this delimiter represents (1 italic, 2 bold, 3 both, 2 strike). */
  count: number;
  /** The raw marker characters (e.g. "**") — restored if the span never closes. */
  literal: string;
  /** Index into `nodes` of this opener's fmt placeholder. */
  nodeIndex: number;
  node: FmtNode;
}

const isWhitespace = (c: string): boolean => /\s/.test(c);
// CommonMark treats Unicode punctuation AND symbols as punctuation for
// flanking purposes; \p{P} + \p{S} with the u flag is the ES2018+ way.
const isPunct = (c: string): boolean => /[\p{P}\p{S}]/u.test(c);

/** Find a same-length backtick run closing a code span, or -1 if unclosed. */
function findBacktickClose(input: string, from: number, run: number): number {
  let j = from;
  while (j <= input.length - run) {
    let k = 0;
    while (j + k < input.length && input[j + k] === "`") k++;
    if (k === run) return j;
    j += Math.max(1, k);
  }
  return -1;
}

/** Innermost stack entry with the same char and count, or -1. */
function findOpener(stack: OpenDelim[], char: string, count: number): number {
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k].char === char && stack[k].count === count) return k;
  }
  return -1;
}

/** Flatten the node tree into leaf segments, accumulating ancestor formats. */
function flatten(nodes: Node[], inherited: Format[] = []): Segment[] {
  const segments: Segment[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      segments.push({
        text: node.text,
        formats: node.code ? [...inherited, "code"] : inherited,
      });
    } else {
      segments.push(...flatten(node.children, [...inherited, ...node.formats]));
    }
  }
  return mergeAdjacent(segments);
}

/** Merge adjacent segments that carry identical formats. */
function mergeAdjacent(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.formats.join(",") === seg.formats.join(",")) {
      last.text += seg.text;
    } else {
      out.push({ text: seg.text, formats: [...seg.formats] });
    }
  }
  return out;
}

// ── Inline Segment Renderer ──

function SegmentText({ segment, theme }: { segment: Segment; theme?: MarkdownTextProps["theme"] }) {
  const props: Record<string, any> = {};

  if (segment.formats.includes("bold")) props.bold = true;
  if (segment.formats.includes("italic")) props.italic = true;
  if (segment.formats.includes("strike")) props.strikethrough = true;
  if (segment.formats.includes("code")) props.dimColor = true;

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

  // An empty string is an intentional blank line (used for spacing between
  // blocks). Render it as a real empty line rather than collapsing to null,
  // otherwise the surrounding output runs together with no breathing room.
  if (text === "") return <Text>{" "}</Text>;
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

  // ── Table: multi-line pipe-separated with separator row ──
  if (isTableBlock(text)) {
    return <MarkdownTable theme={theme}>{text}</MarkdownTable>;
  }

  // ── Heading: #, ##, ###, etc. ──
  const headingMatch = text.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    // Headings carry inline formatting too: "# **Bold** plan" must render the
    // bold, not a literal "**Bold**".
    const segs = parseInline(headingMatch[2]);
    return (
      <Text bold={level <= 3}>
        {segs.map((seg, i) => (
          <SegmentText key={i} segment={seg} theme={theme} />
        ))}
      </Text>
    );
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
