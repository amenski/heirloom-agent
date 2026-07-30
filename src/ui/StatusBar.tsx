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
  /** Whether the agent is currently busy */
  busy?: boolean;
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
  busy,
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

  // Build the full status string from segments
  const segmentTexts = segments.map((seg) => {
    let text = seg.text;

    if (t && theme.colorEnabled) {
      if (seg.color === "red") {
        text = fg(t.errorFg, text);
      } else if (seg.color === "yellow") {
        text = fg(t.warningFg, text);
      } else if (seg.bold) {
        text = fg(t.modelFg, text);
      } else if (seg.dimColor) {
        text = dim(text);
      }
    }

    return text;
  });

  const statusLine = segmentTexts.join("");

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

  // Busy indicator
  let busyStr = "";
  if (busy) {
    busyStr = theme.colorEnabled
      ? `\x1b[38;5;${t.warningFg}m\u25CF\x1b[0m `
      : "* ";
  }

  // Smart truncation based on terminal width
  const fullText = `${busyStr}${statusLine}${gitStr}${timerStr}${tokenStr}`;
  const visibleLen = fullText.replace(/\x1b\[[0-9;]*m/g, "").length;

  // If the status line exceeds terminal width, truncate from the left (remove segments)
  const maxWidth = Math.max(term.columns - 4, 10);

  const rule = dim("\u2500".repeat(Math.max(0, Math.min(term.columns, 200))));

  if (visibleLen > maxWidth) {
    // Truncate the status line by removing middle segments.
    // Keep the first segments that fit; drop the rest behind an ellipsis.
    const firstParts: string[] = [];
    let firstLen = 0;
    const halfMax = Math.floor((maxWidth - timerStr.length - gitStr.length - tokenStr.length - busyStr.length - 4) / 2);

    for (const segText of segmentTexts) {
      const cleanLen = segText.replace(/\x1b\[[0-9;]*m/g, "").length;
      if (firstLen + cleanLen < halfMax) {
        firstParts.push(segText);
        firstLen += cleanLen;
      } else {
        break;
      }
    }

    // Show truncated version with just key info
    const truncated = `${busyStr}${firstParts.join("")}${dim(" \u2026 ")}${timerStr}${gitStr}${tokenStr}`;
    return (
      <Box flexDirection="column">
        <Text>{rule}</Text>
        <Text>{truncated}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{rule}</Text>
      <Text>
        {busyStr}
        {statusLine}
        {gitStr}
        {timerStr}
        {tokenStr}
      </Text>
    </Box>
  );
}

export default memo(StatusBar);
