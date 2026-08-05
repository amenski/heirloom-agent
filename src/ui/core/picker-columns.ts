// Column geometry for the model picker.
//
// The status fields (provider, context window, key state) used to be appended
// after a padded label as variable-width text, so each row had to be read left
// to right like a sentence. Giving every field a fixed x-position turns the list
// into a table: the eye scans one column at a time and comparing two models is
// a vertical glance rather than a parse.
//
// Widths are derived from the whole row set, not per row — that is what makes
// the columns line up — and the label column absorbs any slack so the status
// fields stay pinned to the right edge.

export type ColumnRow = {
  label: string;
  providerLabel?: string;
  ctx?: string;
};

export type ColumnWidths = {
  /** Model name column; absorbs leftover width. */
  label: number;
  /** Provider name column. */
  provider: number;
  /** Context-window column, right-aligned within itself. */
  ctx: number;
};

/** Gap between adjacent columns. */
export const COLUMN_GAP = 2;

/** Width reserved for the trailing state marker (a dot, or nothing). */
export const STATE_WIDTH = 1;

/**
 * Compute column widths for a set of rows within `available` columns.
 *
 * `available` is the usable interior width of the panel. If the natural widths
 * do not fit, the label column shrinks first (model names are the most
 * truncatable field, and the start of a name is the identifying part).
 */
export function computeColumns(rows: ColumnRow[], available: number): ColumnWidths {
  const natural = (pick: (r: ColumnRow) => string | undefined) =>
    rows.reduce((max, r) => Math.max(max, (pick(r) ?? "").length), 0);

  const provider = natural((r) => r.providerLabel);
  const ctx = natural((r) => r.ctx);
  const fixed = provider + ctx + STATE_WIDTH + COLUMN_GAP * 3;

  return {
    label: Math.max(8, available - fixed),
    provider,
    ctx,
  };
}

/** Pad (or truncate with an ellipsis) to exactly `width` columns. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length === width) return text;
  if (text.length < width) return text.padEnd(width);
  if (width === 1) return "…";
  return text.slice(0, width - 1) + "…";
}

/** Right-align within `width`, truncating from the left if needed. */
export function fitRight(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length >= width) return text.slice(text.length - width);
  return text.padStart(width);
}
