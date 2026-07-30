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
import { Box, Text, Static } from "ink";
import MarkdownText from "./MarkdownText.js";
import { useTheme } from "./contexts.js";
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
  const summary = useMemo(() => needsSummary(line), [line]);

  if (summary) {
    const collapsed = summarizeText(line);
    return (
      <Box flexDirection="column">
        <MarkdownText>{collapsed}</MarkdownText>
        <Text dimColor>{summary}</Text>
      </Box>
    );
  }

  return <MarkdownText>{line}</MarkdownText>;
});

// ── Main OutputArea ──

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

      {/* Committed lines (never re-render once committed via <Static>) */}
      <Static items={displayLines}>
        {(line, i) => <OutputLine key={i} line={line} />}
      </Static>

      {/* Active streaming line */}
      {activeLine !== "" && !busy && <MarkdownText>{activeLine}</MarkdownText>}
    </>
  );
}

export default memo(OutputArea);
