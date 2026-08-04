/**
 * Generic subsequence fuzzy matching, shared by every searchable picker
 * (/model, /skills, ...). Kept SDK-independent so it stays unit testable
 * apart from any view or entry type.
 */

/**
 * Subsequence fuzzy match — every char of `query` must appear in `text` in
 * order, but not necessarily adjacently. "dsp" matches "deepseek-v4-pro".
 * Returns a score (lower = tighter match) or null when it doesn't match.
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();

  // A plain substring hit is always a better match than a scattered
  // subsequence, so rank it ahead of everything else.
  const direct = t.indexOf(q);
  if (direct !== -1) return direct;

  let ti = 0;
  let firstHit = -1;
  let lastHit = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    if (firstHit === -1) firstHit = found;
    lastHit = found;
    ti = found + 1;
  }
  // Prefer matches that are compact and start early; offset past every
  // substring score so substring hits always win.
  return 1000 + (lastHit - firstHit) + firstHit;
}
