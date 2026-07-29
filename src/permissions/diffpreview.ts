import { readFileSync, existsSync } from "node:fs";

function computePreviewDiff(toolName: string, args: Record<string, unknown>): string | null {
  const path = String(args.path || args.filePath || "");
  if (!path || !existsSync(path)) return null;

  const original = readFileSync(path, "utf-8");
  let preview = "";

  if (toolName === "edit") {
    const oldStr = String(args.oldString || "");
    const newStr = String(args.newString || "");
    preview = generateUnifiedDiff(path, original, oldStr, newStr);
  } else if (toolName === "write_to_file" || toolName === "write") {
    const content = String(args.content || "");
    preview = generateFullDiff(path, original, content);
  } else if (toolName === "search_replace") {
    const search = String(args.search || "");
    const replace = String(args.replace || "");
    preview = generateReplacePreview(path, original, search, replace);
  } else if (toolName === "apply_diff" || toolName === "apply_patch") {
    const diffContent = String(args.diff || args.patch || "");
    const lines = diffContent.split("\n");
    preview = lines.slice(0, 10).join("\n");
    if (lines.length > 10) preview += `\n(+${lines.length - 10} more lines)`;
  }

  if (!preview) return null;
  return preview;
}

function generateUnifiedDiff(filePath: string, original: string, oldStr: string, newStr: string): string {
  const startIdx = original.indexOf(oldStr);
  if (startIdx === -1) return `(replacement not found in current file — may have been modified since)`;

  const before = original.slice(0, startIdx);
  const beforeLines = before.split("\n");
  const startLine = beforeLines.length;
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  let diff = `--- ${filePath}\n+++ ${filePath}\n`;
  diff += `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@\n`;

  const contextBefore = beforeLines.slice(-2).filter(l => l !== "" || true);
  for (const line of contextBefore) {
    diff += ` ${line}\n`;
  }

  for (const line of oldLines) {
    diff += `\x1b[31m-${line}\x1b[0m\n`;
  }
  for (const line of newLines) {
    diff += `\x1b[32m+${line}\x1b[0m\n`;
  }

  const afterStart = startIdx + oldStr.length;
  const after = original.slice(afterStart);
  const afterLines = after.split("\n").slice(0, 2);
  for (const line of afterLines) {
    if (line !== undefined) diff += ` ${line}\n`;
  }

  return diff;
}

function generateFullDiff(filePath: string, original: string, newContent: string): string {
  const origLines = original.split("\n");
  const newLines = newContent.split("\n");

  let diff = `--- ${filePath}\n+++ ${filePath}\n`;
  diff += `@@ -1,${origLines.length} +1,${newLines.length} @@\n`;

  for (const line of origLines) {
    diff += `\x1b[31m-${line}\x1b[0m\n`;
  }
  for (const line of newLines) {
    diff += `\x1b[32m+${line}\x1b[0m\n`;
  }

  return diff;
}

function generateReplacePreview(filePath: string, original: string, search: string, replace: string): string {
  const count = countOccurrences(original, search);
  if (count === 0) return `(replacement not found in current file — may have been modified since)`;

  const firstIdx = original.indexOf(search);
  const before = original.slice(0, firstIdx);
  const beforeLines = before.split("\n");
  const startLine = beforeLines.length;
  const searchLines = search.split("\n");
  const replaceLines = replace.split("\n");

  let diff = `--- ${filePath}\n+++ ${filePath}\n`;
  diff += `@@ -${startLine},${searchLines.length} +${startLine},${replaceLines.length} @@ (${count} occurrence${count > 1 ? "s" : ""})\n`;

  const contextBefore = beforeLines.slice(-2);
  for (const line of contextBefore) {
    diff += ` ${line}\n`;
  }

  for (const line of searchLines) {
    diff += `\x1b[31m-${line}\x1b[0m\n`;
  }
  for (const line of replaceLines) {
    diff += `\x1b[32m+${line}\x1b[0m\n`;
  }

  const afterStart = firstIdx + search.length;
  const after = original.slice(afterStart);
  const afterLines = after.split("\n").slice(0, 2);
  for (const line of afterLines) {
    if (line !== undefined) diff += ` ${line}\n`;
  }

  return diff;
}

function countOccurrences(str: string, search: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

function formatPreview(preview: string, maxLines: number = 40): string {
  const lines = preview.split("\n");
  if (lines.length <= maxLines) return preview;
  return lines.slice(0, maxLines).join("\n") + `\n(+${lines.length - maxLines} more)`;
}

export function previewEdit(toolName: string, args: Record<string, unknown>): string | null {
  const raw = computePreviewDiff(toolName, args);
  if (!raw) return null;
  return formatPreview(raw);
}
