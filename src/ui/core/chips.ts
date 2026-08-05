// Small inline "chips" — a label on its own background, the terminal analogue
// of a UI pill or key-cap. Built as raw ANSI rather than Ink <Box> nodes so a
// chip stays INSIDE a single row: a bordered Box would occupy three rows and
// break the composer's constant height.
//
// Padding uses regular spaces inside the background run, which is what gives
// the raised look — the fill extends one column past the text on each side.

import { ansiBg, ansiFg, ANSI_RESET } from "../theme.js";

/**
 * A filled chip: text on a background slab, padded one column each side.
 *
 * `colorEnabled: false` degrades to bracketed text so the shape survives on a
 * terminal without colour — the chip still reads as a discrete token.
 */
export function chip(
  text: string,
  opts: { fg: number; bg: number; colorEnabled: boolean },
): string {
  if (!opts.colorEnabled) return `[${text}]`;
  return `${ansiBg(opts.bg)}${ansiFg(opts.fg)} ${text} ${ANSI_RESET}`;
}

/**
 * A key-cap chip for a keyboard chord (e.g. "⇧ Tab"). Same shape as `chip` but
 * with a dimmer default treatment, since a hint should never outweigh status.
 */
export function keyCap(
  text: string,
  opts: { fg: number; bg: number; colorEnabled: boolean },
): string {
  return chip(text, opts);
}

/** Visible width of a string, ignoring ANSI escapes. */
export function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * A horizontal meter: a filled run followed by an unfilled run.
 *
 * Rendered with box-drawing characters rather than blocks so it reads as a thin
 * rule rather than a heavy bar — the context meter is ambient information, not
 * something that should dominate the row.
 */
export function meter(
  percent: number,
  width: number,
  opts: { fg: number; dim: number; colorEnabled: boolean },
): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const bar = "━".repeat(filled);
  const rest = "━".repeat(Math.max(0, width - filled));
  if (!opts.colorEnabled) return bar + rest;
  return `${ansiFg(opts.fg)}${bar}${ANSI_RESET}${ansiFg(opts.dim)}${rest}${ANSI_RESET}`;
}
