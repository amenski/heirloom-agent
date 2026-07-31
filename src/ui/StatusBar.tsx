/**
 * Heirloom StatusBar — Professional-grade status line
 *
 * Displays:
 * - Current mode (with mode-specific color)
 * - Provider/model
 * - Working directory (smart-truncated based on terminal width)
 * - Context usage % (color-coded: safe/yellow/red) with visual bar
 * - Session cost (dollar amount)
 * - Effort level
 * - Git branch + status indicators (ahead/behind/dirty)
 * - Session duration timer (HH:MM:SS)
 * - Token counts for current session
 *
 * All colors are theme-driven via ThemeContext.
 */

import React, { useState, useEffect, useMemo, memo } from "react";
import { Box, Text } from "ink";
import type { StatusSegment, GitStatus } from "./types.js";
import { useTheme, useTerminalInfo } from "./contexts.js";

interface StatusBarProps {
  segments: StatusSegment[];
  /** Optional git status to display */
  gitStatus?: GitStatus | null;
  /** Whether to show the session timer */
  showTimer?: boolean;
  /** Unix timestamp when the session started (ms) */
  sessionStart?: number;
  /** Session token counts for display */
  tokenCounts?: { input: number; output: number } | null;
}

/**
 * Format elapsed time as HH:MM:SS.
 */
function formatElapsed(startMs: number, nowMs: number): string {
  const elapsed = Math.floor((nowMs - startMs) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatElapsedShort(startMs: number, nowMs: number): string {
  const elapsed = Math.floor((nowMs - startMs) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  return `${minutes}m${seconds}s`;
}

/**
 * Build a git status indicator string.
 */
function gitStatusString(git: GitStatus): string {
  const parts: string[] = [];

  // Branch name
  parts.push(git.branch);

  // Dirty indicator
  if (git.dirty) {
    const indicators: string[] = [];
    if (git.modified > 0) indicators.push(`~${git.modified}`);
    if (git.added > 0) indicators.push(`+${git.added}`);
    if (git.deleted > 0) indicators.push(`-${git.deleted}`);
    if (git.staged > 0) indicators.push(`\u25CF${git.staged}`);
    if (git.conflicts > 0) indicators.push(`!${git.conflicts}`);
    if (indicators.length > 0) parts.push(indicators.join(""));
  }

  // Ahead/behind
  if (git.ahead > 0 && git.behind > 0) {
    parts.push(`\u2191${git.ahead}\u2193${git.behind}`);
  } else if (git.ahead > 0) {
    parts.push(`\u2191${git.ahead}`);
  } else if (git.behind > 0) {
    parts.push(`\u2193${git.behind}`);
  }

  return parts.join(" ");
}

function StatusBar({
  segments,
  gitStatus,
  showTimer = false,
  sessionStart,
  tokenCounts,
}: StatusBarProps) {
  const theme = useTheme();
  const term = useTerminalInfo();
  const [now, setNow] = useState(Date.now());

  // Update timer every second
  useEffect(() => {
    if (!showTimer || !sessionStart) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [showTimer, sessionStart]);

  // No segments + no git status + no timer + no tokens = nothing to show
  if (segments.length === 0 && !gitStatus && !showTimer && !tokenCounts) return null;

  const t = theme.theme.statusBar;
  const dim = (s: string) => (theme.colorEnabled ? `\x1b[2m${s}\x1b[0m` : s);
  const fg = (c: number, s: string) => (theme.colorEnabled ? `\x1b[38;5;${c}m${s}\x1b[0m` : s);

  // ansi256 codes for named colors used by config-driven statusline providers.
  const NAMED_ANSI256: Record<string, number> = {
    cyan: 51, green: 46, blue: 39, magenta: 201, white: 231, gray: 244, grey: 244,
  };

  // Build the full status string from segments
  const segmentTexts = segments.map((seg) => {
    let text = seg.text;

    if (t && theme.colorEnabled) {
      if (seg.color === "red") {
        text = fg(t.errorFg, text);
      } else if (seg.color === "yellow") {
        text = fg(t.warningFg, text);
      } else if (seg.color && seg.color in NAMED_ANSI256) {
        text = fg(NAMED_ANSI256[seg.color], text);
      } else if (seg.bold) {
        text = fg(t.modelFg, text);
      } else if (seg.dimColor) {
        text = dim(text);
      }
    }

    return text;
  });

  const sep = dim(" · ");
  const statusLine = segmentTexts.join(sep);

  // Git status (if available)
  let gitStr = "";
  if (gitStatus) {
    gitStr = gitStatusString(gitStatus);
    if (t && theme.colorEnabled) {
      if (gitStatus.dirty) {
        gitStr = fg(t.warningFg, ` ${gitStr}`);
      } else {
        gitStr = dim(` ${gitStr}`);
      }
    } else {
      gitStr = ` ${gitStr}`;
    }
  }

  // Session timer — adaptive format based on duration
  let timerStr = "";
  if (showTimer && sessionStart) {
    const elapsed = now - sessionStart;
    if (elapsed > 3600000) {
      // Over an hour: show HH:MM:SS
      timerStr = dim(` ${formatElapsed(sessionStart, now)}`);
    } else {
      timerStr = dim(` ${formatElapsedShort(sessionStart, now)}`);
    }
  }

  // Token counts
  let tokenStr = "";
  if (tokenCounts && (tokenCounts.input > 0 || tokenCounts.output > 0)) {
    const inK = (tokenCounts.input / 1000).toFixed(0);
    const outK = (tokenCounts.output / 1000).toFixed(0);
    tokenStr = dim(` \u0394${inK}k/\u2191${outK}k`);
  }

  // A single status line (no extra horizontal rule \u2014 the input box above already
  // provides the visual divider). Fixed trailing info (git/timer/tokens) is
  // always kept; the model/mode/ctx/cost/effort segments fill the remaining
  // width, and any that don't fit are dropped behind an ellipsis.
  const cleanLen = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
  const sepLen = cleanLen(sep);
  const maxWidth = Math.max(term.columns - 1, 10);
  const fixedLen = cleanLen(gitStr) + cleanLen(timerStr) + cleanLen(tokenStr);

  const segBudget = maxWidth - fixedLen;
  const fullSegLen = cleanLen(statusLine);

  let segmentBody: string;
  if (fullSegLen <= segBudget) {
    segmentBody = statusLine;
  } else {
    const kept: string[] = [];
    let used = 0;
    const ellipsisLen = 2; // "\u2026"
    for (const segText of segmentTexts) {
      const len = cleanLen(segText);
      const addLen = (kept.length > 0 ? sepLen : 0) + len;
      if (used + addLen + sepLen + ellipsisLen <= segBudget) {
        kept.push(segText);
        used += addLen;
      } else {
        break;
      }
    }
    segmentBody = kept.length > 0 ? `${kept.join(sep)}${dim(" \u2026")}` : dim("\u2026");
  }

  return (
    <Box>
      <Text>
        {segmentBody}
        {gitStr}
        {timerStr}
        {tokenStr}
      </Text>
    </Box>
  );
}

export default memo(StatusBar);
