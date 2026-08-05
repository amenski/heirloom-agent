// How a submitted prompt is drawn in the transcript.
//
// The echo used to be flattened with .replace(/\n/g, " ") because the output
// area treats one array entry as one rendered line — a multi-line prompt broke
// that assumption. Flattening silently rewrote the user's text, so instead the
// renderer splits the echo itself and draws a gutter on every line.
//
// Very large pastes still collapse: a 500-line file dumped into scrollback
// buries the conversation, and the full text is already in the model's context.

/**
 * Above this many lines an echo collapses to a summary. Sized so an ordinary
 * multi-line prompt (a short list, a stack trace, a snippet) stays fully
 * visible — only genuine file-sized pastes collapse.
 */
export const MAX_ECHO_LINES = 12;

/** Above this many characters an echo collapses even if it is few lines. */
export const MAX_ECHO_CHARS = 1200;

export type EchoBlock = {
  /** Lines to draw, each already gutter-prefixed by the caller. */
  lines: string[];
  /** Summary shown when the echo was truncated, else null. */
  truncated: string | null;
};

/**
 * Split an echo into display lines, collapsing an oversized one.
 *
 * A collapsed echo keeps its opening lines — enough to recognise what was sent —
 * and reports how much was hidden. Nothing here changes what the model received.
 */
export function formatEcho(
  text: string,
  maxLines: number = MAX_ECHO_LINES,
  maxChars: number = MAX_ECHO_CHARS,
): EchoBlock {
  const lines = text.split("\n");

  if (lines.length <= maxLines && text.length <= maxChars) {
    return { lines, truncated: null };
  }

  const head = lines.slice(0, maxLines);
  const hiddenLines = lines.length - head.length;
  const hiddenChars = text.length - head.join("\n").length;

  // A long single-line paste has nothing to hide by line count; report chars.
  if (hiddenLines <= 0) {
    return {
      lines: [text.slice(0, maxChars)],
      truncated: `… +${text.length - maxChars} more chars`,
    };
  }

  return {
    lines: head,
    truncated: `… +${hiddenLines} more line${hiddenLines === 1 ? "" : "s"} (${hiddenChars} chars)`,
  };
}
