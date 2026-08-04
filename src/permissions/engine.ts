import { join, relative, isAbsolute, resolve, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { PermissionAction, PermissionRule, PermissionSubject } from "./rules.js";
import { buildSubject, patternMatches, specificity, serializeRulePattern } from "./rules.js";
import { buildBashSubject } from "./bash-normalize.js";
import { BUILTIN_DESTRUCTIVE_RULES } from "./destructive.js";
import { BUILTIN_GUARDED_RULES } from "./guarded.js";
import { BUILTIN_ALLOW_RULES } from "./builtin-allow.js";

export type { PermissionAction, PermissionRule, PatternKind, RuleOrigin } from "./rules.js";

export interface PermissionConfig {
  rules?: PermissionRule[];
  defaultMode?: "allowAll" | "askAll";
}

export interface ResolveResult {
  action: PermissionAction;
  winningRule?: PermissionRule;
  /** True when any bash segment couldn't be safely classified — see bash-normalize.ts. Never bypassable by an auto-approve posture. */
  wasUnresolved: boolean;
  /** True when the winning rule is origin "builtin-guarded" (secret-adjacent path). Never bypassable by an auto-approve posture, same as wasUnresolved. */
  isGuarded: boolean;
}

/** Internal shape used by the private resolution helpers, before isGuarded is derived at the resolve() boundary. */
type InternalResolveResult = Omit<ResolveResult, "isGuarded">;

interface OnDiskRule {
  tool: string;
  pattern: string;
  action: PermissionAction;
}

export class PermissionEngine {
  private configRules: PermissionRule[];
  private sessionRules: PermissionRule[] = [];
  private defaultMode: "allowAll" | "askAll";
  private workingDir: string;
  private projectConfigDir: string;

  /** Tools whose exact/glob patterns carry file paths (normalized on load). */
  private static readonly FILE_TOOLS = new Set([
    "read_file", "write_to_file", "edit", "list_files", "glob",
  ]);

  /** Read-only file tools eligible for the "grant whole folder" broadening offer. */
  private static readonly READ_TOOLS = new Set([
    "read_file", "list_files", "glob",
  ]);

  /**
   * Write/edit file tools eligible for the "grant whole folder" broadening
   * offer. A recursive write grant is materially riskier than a recursive
   * read grant (it lets the agent modify or overwrite anything under the
   * folder, not just see it), so this offer is gated more strictly than the
   * read one — see the hasSibling check in folderScopeRule.
   */
  private static readonly WRITE_TOOLS = new Set([
    "edit", "edit_file", "write_to_file", "search_replace", "apply_diff", "apply_patch",
  ]);

  constructor(config?: PermissionConfig, workingDir?: string) {
    this.workingDir = workingDir ?? process.cwd();
    this.configRules = (config?.rules ?? []).map((r) => this.normalizeConfigRule(r));
    this.defaultMode = config?.defaultMode ?? "askAll";
    this.projectConfigDir = join(this.workingDir, ".heirloom");
  }

  /**
   * Normalize exact-match pattern paths in user-authored rules at load time so
   * they survive a change in path spelling. Does NOT touch glob patterns —
   * prepending "./" to a glob like "**" / "**\/*.ts" shifts its anchoring and
   * can break matching (e.g. "./**" won't match a top-level ".env" the way
   * "**" does). Also guards against the "undefined" string literal that
   * buildSubject produces for file tools called with neither path nor filePath.
   */
  private normalizeConfigRule(r: PermissionRule): PermissionRule {
    if (
      r.kind === "exact" &&
      PermissionEngine.FILE_TOOLS.has(r.tool) &&
      r.pattern &&
      r.pattern !== "undefined"
    ) {
      return { ...r, origin: "config" as const, pattern: this.normalizePath(r.pattern) };
    }
    return { ...r, origin: "config" as const };
  }

  /**
   * Resolves a tool call to an action. For run_bash, splits the command into
   * independent segments and resolves each against the same rule set,
   * combining via most-restrictive-wins: any deny -> deny; else any
   * unresolved-ask or ordinary ask -> ask; else allow.
   */
  resolve(toolName: string, args?: Record<string, unknown>): ResolveResult {
    const a = args ?? {};

    const internal = toolName === "run_bash"
      ? this.resolveBash(String(a.command ?? ""))
      : this.resolveSubject(toolName, this.relativizeSubject(buildSubject(toolName, a)));

    return { ...internal, isGuarded: internal.winningRule?.origin === "builtin-guarded" };
  }

  /**
   * Rewrites a path subject's resolvedPath to be relative to workingDir
   * (e.g. "./src/main.ts") when the path is inside it, so glob rules like
   * "./**" (what migrateLegacyPermissions emits for the old read-in-cwd
   * scope) can actually match — tools always pass absolute paths, and a
   * relative glob pattern can never match one directly. Paths outside
   * workingDir are left as absolute, so they don't spuriously match a
   * "./**"-rooted rule; an absolute glob can still be authored to cover them.
   *
   * Relative paths are first resolved against workingDir so that different
   * spellings of the same path ("src/main.ts", "./src/main.ts") all collapse
   * to the same canonical form. Without this, an exact-match rule approved
   * for one spelling would prompt again for another — same file, different
   * string literal.
   */
  private relativizeSubject(subject: PermissionSubject): PermissionSubject {
    if (!subject.resolvedPath) return subject;

    const normalized = this.normalizePath(subject.resolvedPath);
    return { ...subject, resolvedPath: normalized };
  }

  /**
   * Canonicalize a path to the same form relativizeSubject uses:
   * - Inside workingDir → "./relative/path"
   * - Outside workingDir → absolute path
   */
  private normalizePath(raw: string): string {
    const absolute = isAbsolute(raw) ? raw : resolve(this.workingDir, raw);
    const rel = relative(this.workingDir, absolute);
    if (rel.startsWith("..")) return absolute;
    if (rel === "") return "./";
    return `./${rel}`;
  }

  private resolveBash(command: string): InternalResolveResult {
    const { segments, wasUnresolved } = buildBashSubject(command);

    if (segments.length === 0) {
      return { action: "ask", wasUnresolved: true };
    }

    let combined: InternalResolveResult = this.resolveSubject("run_bash", { tool: "run_bash", text: segments[0] });
    for (const segment of segments.slice(1)) {
      const result = this.resolveSubject("run_bash", { tool: "run_bash", text: segment });
      combined = this.combineMostRestrictive(combined, result);
    }

    // wasUnresolved is fail-closed: it can only push the result toward ask,
    // never let it resolve weaker than ask (an actual deny still wins outright).
    const finalAction = wasUnresolved && combined.action === "allow" ? "ask" : combined.action;
    return { action: finalAction, winningRule: combined.winningRule, wasUnresolved: combined.wasUnresolved || wasUnresolved };
  }

  private combineMostRestrictive(a: InternalResolveResult, b: InternalResolveResult): InternalResolveResult {
    const rank: Record<PermissionAction, number> = { deny: 2, ask: 1, allow: 0 };
    if (rank[b.action] > rank[a.action]) return b;
    return a;
  }

  private resolveSubject(toolName: string, subject: PermissionSubject): InternalResolveResult {
    const allRules = [...BUILTIN_DESTRUCTIVE_RULES, ...BUILTIN_GUARDED_RULES, ...this.configRules, ...this.sessionRules];
    const matches = allRules.filter((r) => patternMatches(r, subject));

    if (matches.length === 0) {
      // Fallback: reads inside the working tree are free. Applied ONLY here,
      // when nothing else matched — a guarded secret-path rule (e.g. .env)
      // would have produced a match above, so it always pre-empts this and
      // still surfaces a prompt. See builtin-allow.ts for why these aren't
      // pooled with the specificity-ranked rules.
      const builtinAllow = BUILTIN_ALLOW_RULES.find((r) => patternMatches(r, subject));
      if (builtinAllow) {
        return { action: "allow", winningRule: builtinAllow, wasUnresolved: false };
      }

      // Only user-configured rules count toward "this tool is recognized" —
      // builtin destructive/guarded rules exist for every install regardless
      // of user intent, so they can't be what makes an unconfigured tool "known."
      const userRules = [...this.configRules, ...this.sessionRules];
      const hasAnyRuleForTool = userRules.some((r) => r.tool === toolName || r.tool === "*" || (r.tool === "mcp__*" && toolName.startsWith("mcp__")));
      if (this.defaultMode === "allowAll" && hasAnyRuleForTool) {
        return { action: "allow", wasUnresolved: false };
      }
      return { action: "ask", wasUnresolved: false };
    }

    const denyMatches = matches.filter((r) => r.action === "deny");
    const askMatches = matches.filter((r) => r.action === "ask");
    const allowMatches = matches.filter((r) => r.action === "allow");

    if (denyMatches.length > 0) {
      return this.resolveTier(denyMatches, allowMatches, "deny");
    }
    if (askMatches.length > 0) {
      return this.resolveTier(askMatches, allowMatches, "ask");
    }
    return { action: "allow", winningRule: this.highestSpecificity(allowMatches), wasUnresolved: false };
  }

  /**
   * Highest-specificity rule of `tier` wins unless an allow rule is strictly
   * more specific than every rule in `tier`. An `any`-kind rule in `tier` is
   * an absolute kill-switch and can never be overridden this way — it scores
   * the floor (0) by construction, so "strictly more specific" would be
   * satisfied by literally any real allow rule, defeating the point of a
   * deliberately unqualified catch-all block.
   */
  private resolveTier(tierMatches: PermissionRule[], allowMatches: PermissionRule[], tier: PermissionAction): InternalResolveResult {
    const bestTierRule = this.highestSpecificity(tierMatches)!;
    if (tierMatches.some((r) => r.kind === "any")) {
      return { action: tier, winningRule: bestTierRule, wasUnresolved: false };
    }

    const maxTierSpecificity = Math.max(...tierMatches.map(specificity));
    const bestAllow = this.highestSpecificity(allowMatches);
    const bestAllowSpecificity = bestAllow ? specificity(bestAllow) : -Infinity;

    if (bestAllow && bestAllowSpecificity > maxTierSpecificity) {
      return { action: "allow", winningRule: bestAllow, wasUnresolved: false };
    }
    return { action: tier, winningRule: bestTierRule, wasUnresolved: false };
  }

  private highestSpecificity(rules: PermissionRule[]): PermissionRule | undefined {
    if (rules.length === 0) return undefined;
    return rules.reduce((best, r) => (specificity(r) > specificity(best) ? r : best));
  }

  /**
   * Builds the narrowest possible allow rule for a specific call — an exact
   * match on its canonical path or literal subject text. Used by the UI layer
   * when the user approves a call for session/always and no winningRule already
   * exists to approve (e.g. the call fell through to defaultMode with zero
   * matching rules), so approval never defaults to something broader than what
   * was actually asked.
   */
  buildDefaultRule(toolName: string, args?: Record<string, unknown>): PermissionRule {
    const a = args ?? {};
    if (toolName === "run_bash") {
      return { tool: "run_bash", kind: "exact", pattern: String(a.command ?? ""), action: "allow", origin: "config" };
    }
    const raw = a.path ?? a.filePath;
    const rawPath = typeof raw === "string" ? raw : "";
    if (!rawPath) {
      return { tool: toolName, kind: "exact", pattern: "", action: "allow", origin: "config" };
    }
    // Normalize the path the same way relativizeSubject does, so the stored
    // rule matches future calls regardless of how the LLM spells the path.
    const normalized = this.normalizePath(rawPath);
    return this.buildPathRule(toolName, normalized);
  }

  /**
   * Builds an allow rule for a file path. Broadens to a directory-scope glob
   * so one approval covers related files, not just the exact path the LLM
   * happened to spell:
   *   - External paths        → parent-directory glob (one level)
   *   - Internal directories   → recursive glob (./dir/**)
   *   - Internal files         → exact match
   */
  private buildPathRule(toolName: string, normalized: string): PermissionRule {
    // External path (doesn't start with "./") → parent directory non-recursive glob
    if (!normalized.startsWith("./")) {
      return {
        tool: toolName,
        kind: "glob",
        pattern: join(dirname(normalized), "*"),
        action: "allow",
        origin: "config",
      };
    }

    // Internal: if the path exists and is a directory → recursive glob
    const absolute = resolve(this.workingDir, normalized.slice(2));
    try {
      if (existsSync(absolute) && statSync(absolute).isDirectory()) {
        return {
          tool: toolName,
          kind: "glob",
          pattern: `${normalized}/**`,
          action: "allow",
          origin: "config",
        };
      }
    } catch {
      // Path doesn't exist or is inaccessible — fall through to exact match
    }

    // Internal file or non-existent path → exact match
    return { tool: toolName, kind: "exact", pattern: normalized, action: "allow", origin: "config" };
  }

  /**
   * For a read or write/edit tool call, returns a recursive-glob allow rule
   * covering the file's parent folder — but ONLY when at least one exact
   * approval already exists for a *different* file in that same folder, for
   * that SAME tool. This is the "second call of this kind in a folder"
   * signal: the first call gets an exact rule with no offer, and only when
   * the user is clearly working within one folder does the UI offer to
   * broaden. Returns undefined when the tool isn't a read or write/edit tool,
   * the path is external, or no sibling exact approval exists yet.
   *
   * Policy: the sibling lookup matches on `r.tool === toolName`, so read and
   * write approvals accumulate separately — prior reads in a folder never
   * unlock a recursive WRITE offer. A write grant is materially more
   * dangerous than a read grant (it lets the agent modify or overwrite
   * anything under the folder), so a write offer requires its own two prior
   * write approvals in that folder rather than piggybacking on read history.
   */
  folderScopeRule(toolName: string, args?: Record<string, unknown>): PermissionRule | undefined {
    if (!PermissionEngine.READ_TOOLS.has(toolName) && !PermissionEngine.WRITE_TOOLS.has(toolName)) return undefined;

    const raw = args?.path ?? args?.filePath;
    if (typeof raw !== "string" || !raw) return undefined;
    const normalized = this.normalizePath(raw);
    // External paths keep their existing parent-dir behavior; no folder offer.
    if (!normalized.startsWith("./")) return undefined;

    const folder = dirname(normalized);
    const folderGlob = `${folder}/**`;

    // Look for an already-approved exact rule for the SAME tool on a
    // *different* file in this same folder, across config + session rules
    // the user has granted.
    const userRules = [...this.configRules, ...this.sessionRules];
    const hasSibling = userRules.some(
      (r) =>
        r.tool === toolName &&
        r.action === "allow" &&
        r.kind === "exact" &&
        r.pattern !== normalized &&
        dirname(r.pattern) === folder,
    );
    if (!hasSibling) return undefined;

    return { tool: toolName, kind: "glob", pattern: folderGlob, action: "allow", origin: "config" };
  }

  /**
   * Approves `rule` for this process only. Never written to disk, cleared on
   * restart. A destructive- or guarded-origin match is forced to kind
   * "exact" on the literal subject text — approving one instance never
   * broadens to the whole category (all destructive commands of that shape,
   * or all secret-adjacent paths of that shape).
   */
  approveForSession(rule: PermissionRule, matchedBuiltin?: PermissionRule): void {
    const narrowed = matchedBuiltin ? this.narrowToExact(rule, matchedBuiltin) : rule;
    this.sessionRules.push({ ...narrowed, origin: "session" });
  }

  /**
   * Approves `rule` for this process and persists it to .heirloom/settings.json
   * via an atomic write (temp file + rename). A destructive- or
   * guarded-origin match is forced to kind "exact" on the literal subject text.
   */
  approveAlways(rule: PermissionRule, matchedBuiltin?: PermissionRule): void {
    const narrowed = matchedBuiltin ? this.narrowToExact(rule, matchedBuiltin) : rule;
    const configRule: PermissionRule = { ...narrowed, origin: "config" };
    this.configRules.push(configRule);
    this.persist();
  }

  /**
   * Safety net: forces kind "exact" for builtin-origin approvals so a future
   * code change that passes a broader rule can't accidentally blanket-approve
   * a whole destructive or guarded category. Currently a no-op in practice —
   * handlePermissionDecision already passes buildDefaultRule (always kind
   * "exact") for builtin-triggered prompts — but kept as defense-in-depth.
   */
  private narrowToExact(rule: PermissionRule, matchedBuiltin: PermissionRule): PermissionRule {
    if (matchedBuiltin.origin !== "builtin-destructive" && matchedBuiltin.origin !== "builtin-guarded") return rule;
    return { ...rule, kind: "exact" };
  }

  private persist(): void {
    const settingsPath = join(this.projectConfigDir, "settings.json");
    let config: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        config = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {}
    }

    const onDiskRules: OnDiskRule[] = this.configRules.map((r) => ({
      tool: r.tool,
      pattern: serializeRulePattern(r.kind, r.pattern),
      action: r.action,
    }));

    config.permissions = { rules: onDiskRules, defaultMode: this.defaultMode };

    if (!existsSync(this.projectConfigDir)) {
      mkdirSync(this.projectConfigDir, { recursive: true });
    }

    const tmpPath = join(this.projectConfigDir, `.settings.json.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    renameSync(tmpPath, settingsPath);
  }
}
