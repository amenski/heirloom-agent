/**
 * Heirloom OutputArea — High-performance scrolling output viewer
 *
 * Features:
 * - Static (committed) line rendering via Ink's <Static> — flushed once into
 *   native terminal scrollback, never repainted
 * - Active line streaming for in-flight content
 * - Progressive disclosure: long blocks auto-collapse with summary
 * - Theme integration via ThemeContext
 * - React.memo for performance
 */

import React, { useMemo, memo } from "react";
import { Box, Static, Text } from "ink";
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
  /**
   * Bumping this remounts the <Static> block, resetting its internal
   * rendered-index so previously-flushed items render again. Ink's standard
   * reset pattern for Static — used when the scrollback itself is cleared
   * (e.g. /clear, /new) and the committed lines array is reset to match.
   */
  staticEpoch: number;
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
  const summary = useMemo(() => needsSummary(line), [line]);

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

// ── Main OutputArea ──

function OutputArea({
  lines,
  activeLine,
  busy,
  staticEpoch,
}: OutputAreaProps) {
  return (
    <>
      {/* Committed lines flush ONCE into native terminal scrollback via Ink's
          <Static> and are never repainted — the transcript stops being a live
          region Ink re-lays-out every frame, which is what let per-frame cost
          scale with session length (and made slow terminal emulators tear).
          `items` is append-only so an index key is stable. Bumping
          `staticEpoch` (via the `key` prop) remounts Static and resets its
          internal rendered-index, the standard reset used when the scrollback
          itself is cleared (see App.tsx's /clear and /new handling). */}
      <Static key={staticEpoch} items={lines}>
        {(line, i) => <OutputLine key={i} line={line} />}
      </Static>

      {/* Active streaming line (carries the same gutter tag as committed output) */}
      {activeLine !== "" && !busy && <OutputLine line={activeLine} />}
    </>
  );
}

export default memo(OutputArea);
