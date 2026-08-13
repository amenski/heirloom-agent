import type { PermissionRule } from "./rules.js";

/**
 * Default allow rules that make read-only exploration inside the working tree
 * free — no prompt for reading, listing, globbing, or searching files under
 * the project root. Mirrors Claude Code's model: the working directory is the
 * trust boundary, and reads within it are low-risk enough to not gate.
 *
 * PRECEDENCE (load-bearing safety property): these are applied ONLY as a
 * fallback when no other rule matched the subject — see resolveSubject. They
 * are deliberately NOT pooled with the specificity-ranked rules, so a
 * guarded secret-path rule (e.g. read_file "**\/.env*" → ask) always
 * pre-empts them: a guarded match makes matches.length > 0, and the fallback
 * is never consulted. A broad "./**" allow in the ranked pool would instead
 * out-specify the narrower guarded ask and silently allow reading secrets —
 * exactly the regression this structure avoids.
 *
 * origin "config" (not a new tier) keeps the rest of the engine — audit,
 * winningRule display, risk classification — treating these like any allow.
 */
export const BUILTIN_ALLOW_RULES: PermissionRule[] = [
  { tool: "read_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" },
  { tool: "list_files", kind: "glob", pattern: "./**", action: "allow", origin: "config" },
  { tool: "glob", kind: "any", pattern: "", action: "allow", origin: "config" },
  { tool: "search", kind: "any", pattern: "", action: "allow", origin: "config" },
  // Meta tool: mutates only the in-memory todo store; same trust class as
  // glob. Never prompts — the model checks items off mid-turn, and a prompt
  // on every call would be noise.
  { tool: "update_todo_list", kind: "any", pattern: "", action: "allow", origin: "config" },
  // Meta tool: side-effect-free — ends the turn with a summary. A prompt on
  // the final call of a task would be pure noise.
  { tool: "attempt_completion", kind: "any", pattern: "", action: "allow", origin: "config" },
];
