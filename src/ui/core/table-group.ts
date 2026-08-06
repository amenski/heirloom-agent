// Groups consecutive markdown-table lines into a single committed entry, at
// APPEND time rather than render time.
//
// This used to happen in OutputArea's render path (mergeTableLines), which
// worked because the whole transcript was a live, re-rendered-every-frame
// array. Once committed lines flush once into Ink's <Static> (see OutputArea),
// that stops being an option: Static items render exactly once and are never
// revisited, so a table whose rows arrive as separate streamed lines across
// several commits could never be retroactively merged into one block. Grouping
// has to happen before a run of table lines is committed.

import { isTableBlock } from "../MarkdownTable.js";

/**
 * Split a queue of pending output lines into what can be committed now and
 * what must wait.
 *
 * On a non-final flush, the largest trailing run of `|`-prefixed lines is held
 * back — it may be an open table still receiving rows from the stream. `final`
 * (turn end, or app teardown) commits everything, since no more rows are
 * coming.
 */
export function splitCommittable(
  queue: string[],
  final: boolean,
): { commit: string[]; hold: string[] } {
  if (final) return { commit: queue, hold: [] };
  let end = queue.length;
  while (end > 0 && queue[end - 1].trimStart().startsWith("|")) {
    end--;
  }
  return { commit: queue.slice(0, end), hold: queue.slice(end) };
}

/**
 * Collapse consecutive `|`-prefixed lines that form a markdown table into one
 * string (rows joined with "\n"). Non-table lines, and pipe-prefixed runs that
 * don't parse as a table, pass through unchanged as individual entries.
 */
export function groupTableLines(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimStart().startsWith("|")) {
      const groupLines: string[] = [lines[i]];
      let j = i + 1;
      while (j < lines.length && lines[j].trimStart().startsWith("|")) {
        groupLines.push(lines[j]);
        j++;
      }
      const groupText = groupLines.join("\n");
      if (groupLines.length >= 2 && isTableBlock(groupText)) {
        out.push(groupText);
      } else {
        out.push(...groupLines);
      }
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out;
}
