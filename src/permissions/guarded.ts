import type { PermissionRule } from "./rules.js";

/**
 * Rules that must always surface a real prompt — never silently
 * auto-allowed by posture or defaultMode: allowAll — but are not denied
 * outright, since reading your own .env or curl-ing an API are legitimate,
 * common actions. origin: "builtin-guarded" resolves to "ask" and is exempt
 * from the posture bypass the same way an unresolved bash segment is (see
 * PermissionEngine.resolve / App.tsx's askUser). Prefix rules here get the
 * same case/absolute-path/flag-reordering hardening as the destructive tier
 * (see matchesBuiltinPrefix in rules.ts).
 *
 * Secret-path scope: read_file/write_to_file/edit only (glob match against
 * the resolved path). run_bash commands that reference these paths as
 * arguments (e.g. `cat .env`) are NOT covered — that would require scanning
 * arbitrary command arguments for path-shaped substrings, which isn't
 * reliable without a bespoke mechanism outside the rule model. Flagged as a
 * known gap.
 *
 * Network-egress scope: run_bash only, matched on the invoked binary's
 * basename. Indirection (`xargs curl`, `echo url | sh`) is caught upstream
 * by isUnresolved's command-carrying-token detection, not here.
 */
export const BUILTIN_GUARDED_RULES: PermissionRule[] = [
  { tool: "read_file", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" },
  { tool: "read_file", kind: "glob", pattern: "**/.ssh/*", action: "ask", origin: "builtin-guarded" },
  { tool: "read_file", kind: "glob", pattern: "**/.aws/*", action: "ask", origin: "builtin-guarded" },
  { tool: "read_file", kind: "glob", pattern: "**/id_rsa*", action: "ask", origin: "builtin-guarded" },
  { tool: "read_file", kind: "glob", pattern: "**/*.pem", action: "ask", origin: "builtin-guarded" },
  { tool: "read_file", kind: "glob", pattern: "**/credentials*", action: "ask", origin: "builtin-guarded" },
  { tool: "write_to_file", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" },
  { tool: "edit", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" },

  { tool: "run_bash", kind: "prefix", pattern: "curl", action: "ask", origin: "builtin-guarded" },
  { tool: "run_bash", kind: "prefix", pattern: "wget", action: "ask", origin: "builtin-guarded" },
  { tool: "run_bash", kind: "prefix", pattern: "nc", action: "ask", origin: "builtin-guarded" },
  { tool: "run_bash", kind: "prefix", pattern: "ssh", action: "ask", origin: "builtin-guarded" },
  { tool: "run_bash", kind: "prefix", pattern: "scp", action: "ask", origin: "builtin-guarded" },
  { tool: "run_bash", kind: "prefix", pattern: "rsync", action: "ask", origin: "builtin-guarded" },

  { tool: "docs_search", kind: "any", pattern: "", action: "ask", origin: "builtin-guarded" },
];
