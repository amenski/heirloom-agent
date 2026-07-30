export type PermissionAction = "allow" | "ask" | "deny";
export type PatternKind = "exact" | "prefix" | "glob" | "any";
export type RuleOrigin = "builtin-destructive" | "config" | "session";

export interface PermissionRule {
  tool: string;
  kind: PatternKind;
  pattern: string;
  action: PermissionAction;
  origin: RuleOrigin;
}

export interface PermissionSubject {
  tool: string;
  text: string;
  resolvedPath?: string;
}

export function matchesTool(ruleTool: string, subjectTool: string): boolean {
  if (ruleTool === "*") return true;
  if (ruleTool === "mcp__*") return subjectTool.startsWith("mcp__");
  return ruleTool === subjectTool;
}

/**
 * True when `textToken` equals `patternToken`, or extends it at a word
 * boundary (a non-alphanumeric character right after the shared prefix).
 * This lets a pattern's final token match real invocations like `~` against
 * `~/Documents` or `mkfs` against `mkfs.ext4`, while still rejecting
 * `commit` against `commitment-plan.sh` (extends mid-word, no boundary).
 */
function matchesTokenBoundary(patternToken: string, textToken: string): boolean {
  if (patternToken === textToken) return true;
  if (!textToken.startsWith(patternToken)) return false;
  const nextChar = textToken[patternToken.length];
  return nextChar !== undefined && !/[A-Za-z0-9]/.test(nextChar);
}

function matchesPrefix(pattern: string, text: string): boolean {
  const patternTokens = pattern.trim().split(/\s+/).filter(Boolean);
  const textTokens = text.trim().split(/\s+/).filter(Boolean);
  if (patternTokens.length > textTokens.length) return false;
  for (let i = 0; i < patternTokens.length; i++) {
    const isLast = i === patternTokens.length - 1;
    if (isLast) {
      if (!matchesTokenBoundary(patternTokens[i], textTokens[i])) return false;
    } else if (patternTokens[i] !== textTokens[i]) {
      return false;
    }
  }
  return true;
}

function globToRegex(pattern: string): RegExp {
  const segs = pattern.split("/");
  const parts = segs.map((seg) => {
    if (seg === "**") return "__DOUBLESTAR__";
    let out = "";
    for (const ch of seg) {
      if (ch === "*") out += "[^/]*";
      else if (ch === "?") out += "[^/]";
      else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return out;
  });
  let src = parts.join("/");
  src = src.replace(/__DOUBLESTAR__/g, ".*");
  return new RegExp(`^${src}$`);
}

export function patternMatches(rule: PermissionRule, subject: PermissionSubject): boolean {
  if (!matchesTool(rule.tool, subject.tool)) return false;

  switch (rule.kind) {
    case "any":
      return true;
    case "exact":
      return rule.pattern === subject.text;
    case "prefix":
      return matchesPrefix(rule.pattern, subject.text);
    case "glob": {
      const target = subject.resolvedPath ?? subject.text;
      return globToRegex(rule.pattern).test(target);
    }
    default:
      return false;
  }
}

export function globSpecificity(pattern: string): number {
  const segs = pattern.split("/");
  let score = 0;
  for (const s of segs) {
    if (s === "**") score += 1;
    else if (s.includes("*") || s.includes("?")) score += 5;
    else score += 50;
  }
  return Math.min(score, 490);
}

export function specificity(rule: PermissionRule): number {
  switch (rule.kind) {
    case "exact":
      return 1000 + rule.pattern.length;
    case "prefix":
      return 500 + rule.pattern.trim().split(/\s+/).filter(Boolean).length * 10;
    case "glob":
      return globSpecificity(rule.pattern);
    case "any":
      return 0;
  }
}

export function buildSubject(tool: string, args: Record<string, unknown>): PermissionSubject {
  if (tool === "run_bash") {
    return { tool, text: String(args?.command ?? "") };
  }
  const path = String(args?.path ?? args?.filePath ?? "");
  return { tool, text: path, resolvedPath: path || undefined };
}

const PREFIX_SUFFIX = ":*";

export function parseRulePattern(kind: PatternKind, onDiskPattern: string): string {
  if (kind === "prefix" && onDiskPattern.endsWith(PREFIX_SUFFIX)) {
    return onDiskPattern.slice(0, -PREFIX_SUFFIX.length);
  }
  return onDiskPattern;
}

export function serializeRulePattern(kind: PatternKind, pattern: string): string {
  if (kind === "prefix") return `${pattern}${PREFIX_SUFFIX}`;
  return pattern;
}
