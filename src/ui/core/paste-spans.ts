// A large paste is stored in the prompt buffer verbatim — submit, history, and
// undo all see the real text — but rendering it in full would blow the input up
// to the height of the pasted block. Instead we remember WHERE each paste landed
// and swap that range for a "[pasted 167 chars]" placeholder at draw time only.
//
// Spans are plain [start, end) offsets into the buffer text. They are display
// metadata, never a second source of truth: anything that can't be maintained
// exactly (an edit reaching into a span) drops the span and reveals the real
// text, which is always correct if more verbose.

export type PasteSpan = {
  /** Offset of the first pasted character in the buffer text. */
  start: number;
  /** Offset one past the last pasted character. */
  end: number;
};

/**
 * Pastes shorter than this render as-is. A short paste is usually a path, a URL,
 * or a token the user wants to see and edit; collapsing it hides more than it
 * saves. Multi-line pastes collapse regardless of length (see shouldCollapse).
 */
export const MIN_COLLAPSE_CHARS = 120;

/** Whether a freshly pasted string is big enough to be worth collapsing. */
export function shouldCollapse(pasted: string): boolean {
  return pasted.length >= MIN_COLLAPSE_CHARS || pasted.includes("\n");
}

/** The placeholder shown in place of a collapsed span. */
export function placeholderFor(pasted: string): string {
  const lines = pasted.split("\n").length;
  if (lines > 1) return `[pasted ${lines} lines, ${pasted.length} chars]`;
  return `[pasted ${pasted.length} chars]`;
}

/**
 * Shift existing spans to account for an edit that replaced [editStart, editEnd)
 * with `delta` net characters, and drop any span the edit reached into.
 *
 * A span survives only if the edit lands entirely before it (shift) or entirely
 * after it (unchanged). An edit that touches a span's interior expands that
 * paste back to plain text — the user is editing inside the block, so they need
 * to see it. Insertions exactly at a boundary also drop the span: typing right
 * against a placeholder should grow visible text, not silently join the paste.
 */
export function adjustSpans(
  spans: PasteSpan[],
  editStart: number,
  editEnd: number,
  delta: number,
): PasteSpan[] {
  const out: PasteSpan[] = [];
  for (const span of spans) {
    if (editEnd <= span.start) {
      // Edit strictly before the span (a boundary-touching insert at exactly
      // span.start counts as before, and pushes the span right).
      out.push({ start: span.start + delta, end: span.end + delta });
      continue;
    }
    if (editStart >= span.end) {
      out.push(span); // strictly after — unaffected
      continue;
    }
    // Overlaps the interior: reveal the real text.
  }
  return out;
}

/**
 * Derive the edited range from before/after text and adjust spans accordingly.
 *
 * Every prompt edit funnels through one place, so rather than teaching each
 * handler (backspace, kill-line, word-delete, …) about spans, we recover the
 * edit as the region between the common prefix and common suffix. That is exact
 * for the single contiguous edits the buffer ops produce.
 */
export function applyEditToSpans(spans: PasteSpan[], before: string, after: string): PasteSpan[] {
  if (spans.length === 0 || before === after) return clampSpans(spans, after.length);

  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefix;
  while (suffix < maxSuffix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;

  const editStart = prefix;
  const editEnd = before.length - suffix;
  const delta = after.length - before.length;
  return clampSpans(adjustSpans(spans, editStart, editEnd, delta), after.length);
}

/** Drop spans that no longer sit inside the text (defensive: wholesale replacements). */
export function clampSpans(spans: PasteSpan[], textLength: number): PasteSpan[] {
  return spans.filter((s) => s.start >= 0 && s.end <= textLength && s.end > s.start);
}

export type CollapsedText = {
  /** Text with each collapsed span replaced by its placeholder. */
  text: string;
  /** The buffer cursor mapped into `text` coordinates. */
  cursor: number;
};

/**
 * Replace each span with its placeholder and map the cursor into the result.
 *
 * A cursor inside a collapsed span lands just past that placeholder, so the
 * caret stays visible instead of vanishing into hidden text.
 */
export function collapseForDisplay(
  text: string,
  cursor: number,
  spans: PasteSpan[],
): CollapsedText {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let read = 0;
  let outCursor: number | null = null;

  for (const span of ordered) {
    if (span.start < read) continue; // overlapping/stale span — skip
    const gap = text.slice(read, span.start);
    if (cursor >= read && cursor <= span.start) outCursor = out.length + (cursor - read);
    out += gap;
    out += placeholderFor(text.slice(span.start, span.end));
    if (cursor > span.start && cursor < span.end) outCursor = out.length;
    read = span.end;
  }

  if (cursor >= read) outCursor = out.length + (cursor - read);
  out += text.slice(read);

  return { text: out, cursor: outCursor ?? out.length };
}
