import type { PermissionRule } from "./rules.js";
import { FORK_BOMB } from "./bash-normalize.js";

/**
 * Starting seed, not exhaustive — extend as needed. Each entry deny-by-default,
 * origin "builtin-destructive". Whole-token prefix matching uses a word-boundary
 * rule on the pattern's final token (see matchesTokenBoundary in rules.ts), so
 * "dd if=" matches "dd if=/dev/zero" and "mkfs" matches "mkfs.ext4" without
 * needing separate substring special cases.
 */
export const BUILTIN_DESTRUCTIVE_RULES: PermissionRule[] = [
  { tool: "run_bash", kind: "prefix", pattern: "rm -rf /", action: "deny", origin: "builtin-destructive" },
  { tool: "run_bash", kind: "prefix", pattern: "rm -rf ~", action: "deny", origin: "builtin-destructive" },
  { tool: "run_bash", kind: "prefix", pattern: "git push --force", action: "deny", origin: "builtin-destructive" },
  { tool: "run_bash", kind: "prefix", pattern: "git push -f", action: "deny", origin: "builtin-destructive" },
  { tool: "run_bash", kind: "prefix", pattern: "git reset --hard", action: "deny", origin: "builtin-destructive" },
  { tool: "run_bash", kind: "prefix", pattern: "git clean -fdx", action: "deny", origin: "builtin-destructive" },
  { tool: "run_bash", kind: "prefix", pattern: "mkfs", action: "deny", origin: "builtin-destructive" },
  { tool: "run_bash", kind: "prefix", pattern: "dd if=", action: "deny", origin: "builtin-destructive" },
  { tool: "run_bash", kind: "exact", pattern: FORK_BOMB, action: "deny", origin: "builtin-destructive" },
];
