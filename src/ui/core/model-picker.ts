import type { ModelEntry } from "../types.js";

/**
 * Pure logic for the /model picker: fuzzy matching, provider grouping, and the
 * flat navigable row list the view renders.
 *
 * Kept out of the component so the matching and grouping rules are unit
 * testable without rendering Ink (the view itself only maps rows to <Text>).
 */

/** A rendered row: either a provider heading or a selectable model. */
export type PickerRow =
  | { kind: "header"; provider: string; label: string }
  | {
      kind: "model";
      provider: string;
      model: string;
      label: string;
      contextWindow?: number;
      current: boolean;
      configured: boolean;
    };

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

/** Match against "provider/model" so a query can span both halves. */
export function matchEntry(entry: ModelEntry, query: string): number | null {
  if (!query) return 0;
  const direct = fuzzyScore(`${entry.provider}/${entry.model}`, query);
  const modelOnly = fuzzyScore(entry.model, query);
  if (direct === null && modelOnly === null) return null;
  // A model-name hit is more relevant than one that only lines up by borrowing
  // characters from the provider prefix.
  return Math.min(direct ?? Infinity, (modelOnly ?? Infinity) - 1);
}

export interface BuildRowsOptions {
  entries: ModelEntry[];
  query: string;
  currentProvider: string;
  currentModel?: string;
  /** Provider name -> whether an API key is resolvable for it. */
  configured?: Record<string, boolean>;
  /** Display names for providers (deepseek -> DeepSeek). */
  labels?: Record<string, string>;
}

/**
 * Filter by `query`, group surviving entries under provider headings, and
 * flatten to rows. Providers keep first-seen order from `entries`; within a
 * provider, models are ordered by match quality then name.
 */
export function buildRows({
  entries,
  query,
  currentProvider,
  currentModel,
  configured,
  labels,
}: BuildRowsOptions): PickerRow[] {
  const scored: Array<{ entry: ModelEntry; score: number }> = [];
  for (const entry of entries) {
    const score = matchEntry(entry, query);
    if (score !== null) scored.push({ entry, score });
  }

  const order: string[] = [];
  const byProvider = new Map<string, Array<{ entry: ModelEntry; score: number }>>();
  for (const item of scored) {
    const p = item.entry.provider;
    if (!byProvider.has(p)) {
      byProvider.set(p, []);
      order.push(p);
    }
    byProvider.get(p)!.push(item);
  }

  const rows: PickerRow[] = [];
  for (const provider of order) {
    const items = byProvider.get(provider)!;
    items.sort((a, b) => a.score - b.score || a.entry.model.localeCompare(b.entry.model));
    rows.push({
      kind: "header",
      provider,
      label: labels?.[provider] ?? provider,
    });
    for (const { entry } of items) {
      rows.push({
        kind: "model",
        provider,
        model: entry.model,
        label: entry.model,
        contextWindow: entry.contextWindow,
        current: provider === currentProvider && entry.model === currentModel,
        // Absent map = don't claim anything is unconfigured.
        configured: configured ? configured[provider] !== false : true,
      });
    }
  }
  return rows;
}

/** Indices of selectable rows — headers are display-only and skipped by nav. */
export function selectableIndices(rows: PickerRow[]): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind === "model") out.push(i);
  });
  return out;
}

/**
 * Move the cursor by `delta` selectable rows, wrapping at both ends and
 * stepping over headers. Returns the new row index (or -1 when nothing is
 * selectable).
 */
export function moveSelection(rows: PickerRow[], current: number, delta: number): number {
  const idx = selectableIndices(rows);
  if (idx.length === 0) return -1;
  const pos = idx.indexOf(current);
  if (pos === -1) return idx[0];
  const next = (pos + delta + idx.length) % idx.length;
  return idx[next];
}

/** Format a context window for display: 1000000 -> "1000k ctx". */
export function formatContext(contextWindow?: number): string {
  if (!contextWindow) return "";
  return `${Math.round(contextWindow / 1000)}k ctx`;
}
