/** Max characters kept from a single provider's output (prevents a runaway
 * provider from blowing out the status line). */
export const MAX_SEGMENT_LENGTH = 120;

/**
 * Sanitize untrusted provider output for safe single-line rendering:
 * strip ANSI escape sequences and other C0/C1 control chars, collapse
 * whitespace, trim, and cap length.
 */
export function sanitizeText(text: string, maxLength = MAX_SEGMENT_LENGTH): string {
  const cleaned = text
    // ANSI CSI/SGR escape sequences
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Remaining C0/C1 control characters (keeps normal printable text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}
