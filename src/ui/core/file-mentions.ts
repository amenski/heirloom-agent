import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";

export interface FileMentionItem {
  path: string;
  type: "file" | "directory";
}

const DEFAULT_MAX_ITEMS = 20000;
const DEFAULT_MAX_DEPTH = 8;
const NOISY_DIRS = new Set([
  ".git", ".next", ".pytest_cache", ".ruff_cache", "__pycache__",
  "build", "dist", "node_modules", "out", "target",
]);

export function scanFileMentionItems(root: string, maxItems = DEFAULT_MAX_ITEMS): FileMentionItem[] {
  const items: FileMentionItem[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number) {
    if (items.length >= maxItems || depth > DEFAULT_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (items.length >= maxItems) return;
      if (entry.name.startsWith(".") || NOISY_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (entry.isDirectory()) {
        items.push({ path: rel + "/", type: "directory" });
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        items.push({ path: rel, type: "file" });
      }
    }
  }
  walk(root, 0);
  return items;
}

export function filterFileMentionItems(items: FileMentionItem[], query: string, maxResults = 12): FileMentionItem[] {
  const q = query.toLowerCase();
  const scored = items
    .map((item) => ({ item, score: scoreFileMention(item.path, q) }))
    .filter((s) => s.score !== Infinity)
    .sort((a, b) => a.score - b.score || a.item.path.length - b.item.path.length);
  return scored.slice(0, maxResults).map((s) => s.item);
}

function scoreFileMention(itemPath: string, query: string): number {
  if (!query) return itemPath.endsWith("/") ? 5 : 10;
  const p = itemPath.toLowerCase();
  const base = path.basename(itemPath.replace(/\/$/, "")).toLowerCase();
  if (p === query) return 0;
  if (p.startsWith(query)) return 1;
  if (base.startsWith(query)) return 3;
  const idx = p.indexOf(query);
  if (idx >= 0) return 20 + idx;
  return Infinity;
}
