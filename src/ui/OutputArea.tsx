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
import { isTableBlock } from "./MarkdownTable.js";
import { useTheme } from "./contexts.js";
import { ansi256 } from "./theme.js";
import { USER_ECHO_TAG, COMMAND_ECHO_TAG } from "./constants.js";
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
}: {
  line: string;
}) {
  const theme = useTheme();

  // A user-echo line (tagged with USER_ECHO_TAG) renders with a blue gutter bar
  // on the left and plain text — the gutter is what marks input, so assistant
  // replies can stay plain flush-left text. (A full-width background fill was
  // tried and read as heavier/noisier, so this uses a subtle left rule instead.)
  if (line.startsWith(USER_ECHO_TAG)) {
    const msg = line.slice(USER_ECHO_TAG.length).replace(/\n/g, " ");
    return (
      <Box>
        <Text color={theme.colorEnabled ? ansi256(theme.theme.promptFg) : undefined}>{"▌ "}</Text>
        <Text>{msg}</Text>
      </Box>
    );
  }

  // A slash-command echo (tagged with COMMAND_ECHO_TAG) renders as a plain dim
  // "›" line — a lightweight record of what was typed. Unlike the user-echo bar
  // it gets no background fill, marking it as out-of-band (it makes no model
  // call and is not counted toward context usage).
  if (line.startsWith(COMMAND_ECHO_TAG)) {
    const msg = line.slice(COMMAND_ECHO_TAG.length).replace(/\n/g, " ");
    return (
      <Text dimColor>{`› ${msg}`}</Text>
    );
  }

  const summary = useMemo(() => needsSummary(line), [line]);

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

// ── Main OutputArea ──

function mergeTableLines(lines: string[]): Array<{ text: string; key: number }> {
  const merged: Array<{ text: string; key: number }> = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimStart().startsWith("|")) {
      const groupLines: string[] = [lines[i]];
      let j = i + 1;
      while (j < lines.length && lines[j].trimStart().startsWith("|")) {
        groupLines.push(lines[j]);
        j++;
      }
      const groupText = groupLines.join("\n");
      if (groupLines.length >= 2 && isTableBlock(groupText)) {
        merged.push({ text: groupText, key: i });
      } else {
        groupLines.forEach((l, k) => merged.push({ text: l, key: i + k }));
      }
      i = j;
    } else {
      merged.push({ text: lines[i], key: i });
      i++;
    }
  }
  return merged;
}

function OutputArea({
  lines,
  activeLine,
  busy,
  maxLines = 0,
}: OutputAreaProps) {
  // Truncate to maxLines if configured
  const displayLines = useMemo(() => {
    if (maxLines > 0 && lines.length > maxLines) {
      return lines.slice(lines.length - maxLines);
    }
    return lines;
  }, [lines, maxLines]);

  const mergedLines = useMemo(() => mergeTableLines(displayLines), [displayLines]);

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
      {mergedLines.map((item) => (
        <OutputLine key={item.key} line={item.text} />
      ))}

      {/* Active streaming line (carries the same gutter tag as committed output) */}
      {activeLine !== "" && !busy && <OutputLine line={activeLine} />}
    </>
  );
}

export default memo(OutputArea);
