import React, { memo, useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useTheme, useTerminalInfo } from "./contexts.js";
import { chip } from "./core/chips.js";
import { resolveRefreshProfile } from "./core/refresh-rates.js";

/** Width of the working-indicator field, reserved whether or not it animates. */
const DOTS_WIDTH = 8;

/**
 * How often the working indicator advances. Sourced from the shared refresh
 * profile so all three repaint timers move together — see core/refresh-rates.
 */
const TICK_MS = resolveRefreshProfile().indicatorMs;

export interface Hint {
  /** The key chord, rendered bright (e.g. "esc", "ctrl+shift+p"). */
  key: string;
  /** What the chord does, rendered dim (e.g. "interrupt"). */
  label: string;
}

interface HintBarProps {
  /** Hints pinned to the left edge. */
  left: Hint[];
  /** Hints pinned to the right edge; dropped first when width is tight. */
  right?: Hint[];
  /** True while a turn is running — shows the animated working indicator. */
  working?: boolean;
}

/**
 * The bottom row: keyboard hints, with an optional leading indicator.
 *
 * This is deliberately the LAST line of the frame. Ink repaints a changed line
 * by walking the cursor up from the bottom, so every row below an animating
 * element is rewritten on each tick — putting the only continuously-changing
 * thing (the working indicator) on the final row means nothing sits under it to
 * repaint. See Spinner.tsx.
 */
function HintBar({ left, right = [], working = false }: HintBarProps) {
  const theme = useTheme();
  const term = useTerminalInfo();
  const [frame, setFrame] = useState(0);

  // The animation frame is LOCAL state, like <Spinner>'s was: a tick here must
  // re-render only this one row, never App's subtree (which would re-lay-out the
  // whole transcript 12.5x/second — the original "Working…" freeze).
  useEffect(() => {
    if (!working) return;
    setFrame(0);
    const timer = setInterval(() => setFrame((f) => f + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [working]);

  const dim = (s: string) => (theme.colorEnabled ? `\x1b[2m${s}\x1b[0m` : s);
  // The chord renders as a key-cap (filled chip) and the description stays dim
  // beside it, so the row reads as "this key does that" rather than a run of
  // equally-weighted words.
  const render = (h: Hint) =>
    `${chip(h.key, {
      fg: theme.theme.textDim,
      bg: theme.theme.border,
      colorEnabled: theme.colorEnabled,
    })} ${dim(h.label)}`;
  const width = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

  // A fixed-width travelling dot. The field is always DOTS_WIDTH characters so
  // the row's width never changes and Ink can overwrite in place rather than
  // reflow — but it is appended AFTER the left hints rather than before them.
  // Leading it indented every hint by the field width even when idle, which
  // read as a stray margin; trailing it keeps hints flush to the left edge.
  const dots = working
    ? Array.from({ length: DOTS_WIDTH }, (_, i) =>
        i === frame % DOTS_WIDTH ? "•" : "·",
      ).join("")
    : " ".repeat(DOTS_WIDTH);
  const leftStr = left.map(render).join(dim("  ")) + dim(`  ${dots}`);
  const rightStr = right.map(render).join(dim("  "));

  // Right-align the right group by padding between. If the terminal is too
  // narrow to hold both, drop the right group rather than wrap onto a second
  // row — a wrapped hint bar would add a line for the indicator to repaint over.
  const used = width(leftStr) + width(rightStr);
  const available = Math.max(term.columns - 1, 10);
  const gap = available - used;

  const body = gap >= 2
    ? leftStr + " ".repeat(gap) + rightStr
    : leftStr;

  return (
    <Box>
      <Text>{body}</Text>
    </Box>
  );
}

export default memo(HintBar);
