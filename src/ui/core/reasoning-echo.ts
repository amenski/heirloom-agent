// How a turn's reasoning is echoed into the transcript.
//
// Reasoning is buffered silently while the model thinks and flushed as a single
// output line on the first text token. Emitting the WHOLE buffer meant one line
// of ~1500+ characters that wrapped to seven or more rows appearing in a single
// commit — every row below it shifted at once, which Ink's incremental renderer
// cannot skip (it only reuses rows that keep their index), so the lower half of
// the frame repainted in one jolt. That is the flicker seen at the end of a
// thinking phase.
//
// The echo is a marker that reasoning happened, not a transcript of it: the full
// text is already in the model's context and the reasoning is not addressed to
// the user. So it collapses to a single line.

/**
 * Maximum width of the reasoning echo, in characters.
 *
 * 76 leaves room for the "✱ " marker inside an 80-column terminal — the
 * narrowest width worth designing for. The budget must include the prefix:
 * overflowing by even one character wraps to a second row and reintroduces the
 * multi-row jump this exists to prevent.
 */
export const MAX_REASONING_ECHO = 76;

/**
 * Collapse a reasoning buffer to a single-line echo.
 *
 * Newlines and runs of whitespace become single spaces (reasoning arrives as
 * loosely-formatted prose), and the result is clipped with an ellipsis.
 * Returns null when there is nothing worth showing.
 */
export function summarizeReasoning(
  buffer: string,
  maxWidth: number = MAX_REASONING_ECHO,
): string | null {
  const flat = buffer.trim().replace(/\s+/g, " ");
  if (flat === "") return null;
  if (flat.length <= maxWidth) return flat;
  // Prefer a word boundary so the clip does not end mid-token, but only when
  // one falls reasonably near the limit.
  const clipped = flat.slice(0, maxWidth - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = lastSpace > maxWidth * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${body}…`;
}
