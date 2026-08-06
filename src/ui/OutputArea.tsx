/**
 * Heirloom OutputArea — High-performance scrolling output viewer
 *
 * Features:
 * - Static (committed) line rendering via Ink's <Static>
 * - Active line streaming for in-flight content
 * - Virtual scrolling via optional maxLines truncation
 * - Progressive disclosure: long blocks auto-collapse with summary
 * - Theme integration via ThemeContext
 * - React.memo for performance
 */

import React, { useMemo, memo } from "react";
import { Box, Text } from "ink";
import MarkdownText from "./MarkdownText.js";
import { useTheme } from "./contexts.js";
import { ansi256 } from "./theme.js";
import { USER_ECHO_TAG, COMMAND_ECHO_TAG } from "./constants.js";
import { formatEcho } from "./core/echo-format.js";
import type { TabDefinition } from "./types.js";

interface OutputAreaProps {
  /** Committed (past) output lines */
  lines: string[];
  /** Currently streaming active line */
  activeLine: string;
  /** Whether the agent is busy generating */
  busy: boolean;
  /** Maximum number of lines to keep in view (0 = unlimited) */
  maxLines?: number;
  /**
   * Cap on how many committed lines stay individually rendered (0 = unlimited).
   *
   * Unlike `maxLines` this never discards output: older lines are folded into
   * one collapsed element instead of many, so the transcript stays complete
   * while Ink's per-frame layout cost stops scaling with session length.
   */
  liveLineBudget?: number;
  /** Active tab info (for multiplex mode) */
  tab?: TabDefinition;
}

/**
 * Check if a string is a long block that needs summarizing.
 */
function needsSummary(text: string): string | null {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean.split("\n");
  if (lines.length > 20) {
    return `  \u25BC ${lines.length} lines`;
  }
  if (clean.length > 1000) {
    return `  \u25BC ${clean.length} chars`;
  }
  return null;
}

/**
 * Collapse a long text to a preview.
 */
function summarizeText(text: string): string {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean.split("\n");
  if (lines.length > 20) {
    return [lines[0], lines[1], "", "  ...", `  (${lines.length} lines)`, "", lines[lines.length - 1]].join(
      "\n",
    );
  }
  if (clean.length > 1000) {
    return clean.slice(0, 300) + `\n  ... (${clean.length - 300} more chars)`;
  }
  return text;
}

// ── Memoized Output Line ──

const OutputLine = memo(function OutputLine({
  line,
  verbatim = false,
}: {
  line: string;
  /**
   * Render the text exactly as given, skipping echo/markdown/summary handling.
   * Used for the folded backlog block, whose content is already-rendered output —
   * re-interpreting it would re-tag echoes and let summarizeText drop its middle.
   */
  verbatim?: boolean;
}) {
  const theme = useTheme();
  // Computed unconditionally: hooks must not sit behind an early return.
  const summary = useMemo(() => (verbatim ? null : needsSummary(line)), [line, verbatim]);

  if (verbatim) return <Text>{line}</Text>;

  // A user-echo line (tagged with USER_ECHO_TAG) renders with a blue gutter bar
  // on the left and plain text — the gutter is what marks input, so assistant
  // replies can stay plain flush-left text. (A full-width background fill was
  // tried and read as heavier/noisier, so this uses a subtle left rule instead.)
  if (line.startsWith(USER_ECHO_TAG)) {
    // Draw the gutter on every line rather than flattening the message: the
    // echo must show what was actually submitted, newlines included.
    const { lines: msgLines, truncated } = formatEcho(line.slice(USER_ECHO_TAG.length));
    const gutter = theme.colorEnabled ? ansi256(theme.theme.promptFg) : undefined;
    return (
      <Box flexDirection="column">
        {msgLines.map((msg, i) => (
          <Box key={i}>
            <Text color={gutter}>{"▌ "}</Text>
            <Text>{msg}</Text>
          </Box>
        ))}
        {truncated !== null && (
          <Box>
            <Text color={gutter}>{"▌ "}</Text>
            <Text dimColor>{truncated}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // A slash-command echo (tagged with COMMAND_ECHO_TAG) renders as a plain dim
  // "›" line — a lightweight record of what was typed. Unlike the user-echo bar
  // it gets no background fill, marking it as out-of-band (it makes no model
  // call and is not counted toward context usage).
  if (line.startsWith(COMMAND_ECHO_TAG)) {
    const { lines: msgLines, truncated } = formatEcho(line.slice(COMMAND_ECHO_TAG.length));
    return (
      <Box flexDirection="column">
        {msgLines.map((msg, i) => (
          <Text key={i} dimColor>{i === 0 ? `› ${msg}` : `  ${msg}`}</Text>
        ))}
        {truncated !== null && <Text dimColor>{`  ${truncated}`}</Text>}
      </Box>
    );
  }

  if (summary) {
    return (
      <Box flexDirection="column">
        <MarkdownText>{summarizeText(line)}</MarkdownText>
        <Text dimColor>{summary}</Text>
      </Box>
    );
  }

  return <MarkdownText>{line}</MarkdownText>;
});

// Committed lines are rendered as a memoized block keyed on the merged array,
// so per-character active-line updates (and 80ms spinner ticks) don't re-create
// N elements or re-run the map for the whole transcript every frame.
const CommittedLines = memo(function CommittedLines({
  merged,
}: {
  merged: Array<{ text: string; key: number; folded?: boolean }>;
}) {
  return (
    <>
      {merged.map((item) => (
        <OutputLine key={item.key} line={item.text} verbatim={item.folded === true} />
      ))}
    </>
  );
});

// ── Main OutputArea ──

/**
 * Fold everything older than the last `budget` lines into one entry.
 *
 * The transcript is only stored in this array — there is no <Static> flush, so
 * dropping lines would lose them for good. Joining them into a single element
 * keeps every character on screen while collapsing N Ink layout nodes into one,
 * which is where the per-frame cost actually lives.
 */
export function foldOldLines(
  merged: Array<{ text: string; key: number; folded?: boolean }>,
  budget: number,
): Array<{ text: string; key: number; folded?: boolean }> {
  if (budget <= 0 || merged.length <= budget) return merged;
  const foldCount = merged.length - budget;
  const folded = merged.slice(0, foldCount);
  return [
    { text: folded.map((m) => m.text).join("\n"), key: folded[0].key, folded: true },
    ...merged.slice(foldCount),
  ];
}

function OutputArea({
  lines,
  activeLine,
  busy,
  maxLines = 0,
  liveLineBudget = 0,
}: OutputAreaProps) {
  // Truncate to maxLines if configured
  const displayLines = useMemo(() => {
    if (maxLines > 0 && lines.length > maxLines) {
      return lines.slice(lines.length - maxLines);
    }
    return lines;
  }, [lines, maxLines]);

  // Table grouping now happens at append time (see core/table-group.ts), so
  // `displayLines` already arrives with table blocks pre-joined — this just
  // gives each entry the {text, key} shape foldOldLines expects.
  const mergedLines = useMemo(
    () => foldOldLines(displayLines.map((text, key) => ({ text, key })), liveLineBudget),
    [displayLines, liveLineBudget],
  );

  // Track if we have lines to show the "more lines above" indicator
  const hasMore = maxLines > 0 && lines.length > maxLines;

  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

  return (
    <>
      {/* "More lines above" indicator */}
      {hasMore && (
        <Box>
          <Text dimColor>{dim(`  [${lines.length - maxLines} more lines above]`)}</Text>
        </Box>
      )}

      {/* Committed lines. Rendered as normal live elements (not Ink's <Static>)
          so the pinned WelcomeScreen banner can stay above the conversation —
          <Static> flushes to scrollback above the live frame and would fight the
          banner for the top rows, eating the first message. */}
      <CommittedLines merged={mergedLines} />

      {/* Active streaming line (carries the same gutter tag as committed output) */}
      {activeLine !== "" && !busy && <OutputLine line={activeLine} />}
    </>
  );
}

export default memo(OutputArea);
