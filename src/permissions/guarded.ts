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
 * Dependency-internals scope: read_file/list_files on paths under
 * node_modules. Discovery tools (glob walker, repo map) already skip
 * node_modules; this closes the explicit-path hole so a human always sees a
 * direct read into installed dependencies. Ask, not deny: reading a package's
 * .d.ts or package.json to introspect an installed API is legitimate.
 *
 * search's `dir` argument is now a matchable subject too (extractToolSubject/
 * buildSubject in rules.ts extract it, defaulting to "." like the tool
 * handler does), so the secret-path globs below apply to it the same as
 * read_file — closing what was previously a known gap (grep -rn against
 * ~/.ssh, ~/.aws, etc. with no prompt). The out-of-workspace case (a `dir`
 * outside workingDir generally, not just these specific secret paths) is a
 * separate, dynamic check in PermissionEngine.outOfWorkspaceGuardedRule,
 * since no static glob can express "outside workingDir".
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
  { tool: "search", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" },
  { tool: "search", kind: "glob", pattern: "**/.ssh/*", action: "ask", origin: "builtin-guarded" },
  { tool: "search", kind: "glob", pattern: "**/.aws/*", action: "ask", origin: "builtin-guarded" },
  { tool: "search", kind: "glob", pattern: "**/id_rsa*", action: "ask", origin: "builtin-guarded" },
  { tool: "search", kind: "glob", pattern: "**/*.pem", action: "ask", origin: "builtin-guarded" },
  { tool: "search", kind: "glob", pattern: "**/credentials*", action: "ask", origin: "builtin-guarded" },
  // search's `dir` is commonly the secret directory itself (e.g.
  // `dir: "~/.ssh"`), not a file under it — "**/.ssh/*" alone doesn't match
  // the bare directory (same asymmetry as node_modules above), so these
  // directory-itself variants are needed in addition.
  { tool: "search", kind: "glob", pattern: "**/.ssh", action: "ask", origin: "builtin-guarded" },
  { tool: "search", kind: "glob", pattern: "**/.aws", action: "ask", origin: "builtin-guarded" },
  // glob's `cwd` gets the same secret-path treatment. It discloses filenames
  // rather than contents, so this is milder than search — but enumerating
  // ~/.ssh still tells a caller which keys exist, and the asymmetry of
  // guarding one dir-scoped tool and not the other is its own hazard. Only
  // the directory-itself patterns apply: `cwd` is always a directory, so the
  // file-level globs (**/id_rsa*, **/*.pem) could never match it.
  { tool: "glob", kind: "glob", pattern: "**/.ssh", action: "ask", origin: "builtin-guarded" },
  { tool: "glob", kind: "glob", pattern: "**/.aws", action: "ask", origin: "builtin-guarded" },
  // node_modules: the directory itself (list_files on the package root) and
  // anything under it. `**/node_modules` alone can't match `./node_modules/ink`,
  // and `**/node_modules/**` alone can't match `./node_modules` — both are needed.
  { tool: "read_file", kind: "glob", pattern: "**/node_modules/**", action: "ask", origin: "builtin-guarded" },
  { tool: "list_files", kind: "glob", pattern: "**/node_modules", action: "ask", origin: "builtin-guarded" },
  { tool: "list_files", kind: "glob", pattern: "**/node_modules/**", action: "ask", origin: "builtin-guarded" },
  { tool: "write_to_file", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" },
  { tool: "edit", kind: "glob", pattern: "**/.env*", action: "ask", origin: "builtin-guarded" },

  { tool: "run_bash", kind: "prefix", pattern: "curl", action: "ask", origin: "builtin-guarded" },
  { tool: "run_bash", kind: "prefix", pattern: "wget", action: "ask", origin: "builtin-guarded" },
  { tool: "run_bash", kind: "prefix", pattern: "nc", action: "ask", origin: "builtin-guarded" },
  { tool: "run_bash", kind: "prefix", pattern: "ssh", action: "ask", origin: "builtin-guarded" },
  { tool: "run_bash", kind: "prefix", pattern: "scp", action: "ask", origin: "builtin-guarded" },
  { tool: "run_bash", kind: "prefix", pattern: "rsync", action: "ask", origin: "builtin-guarded" },

  { tool: "web_search", kind: "any", pattern: "", action: "ask", origin: "builtin-guarded" },
];
