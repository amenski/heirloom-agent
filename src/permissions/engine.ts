import { join, relative, isAbsolute } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { PermissionAction, PermissionRule, PermissionSubject } from "./rules.js";
import { buildSubject, patternMatches, specificity, serializeRulePattern } from "./rules.js";
import { buildBashSubject } from "./bash-normalize.js";
import { BUILTIN_DESTRUCTIVE_RULES } from "./destructive.js";

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
}

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

  constructor(config?: PermissionConfig, workingDir?: string) {
    this.configRules = (config?.rules ?? []).map((r) => ({ ...r, origin: "config" as const }));
    this.defaultMode = config?.defaultMode ?? "askAll";
    this.workingDir = workingDir ?? process.cwd();
    this.projectConfigDir = join(this.workingDir, ".deepcode");
  }

  /**
   * Resolves a tool call to an action. For run_bash, splits the command into
   * independent segments and resolves each against the same rule set,
   * combining via most-restrictive-wins: any deny -> deny; else any
   * unresolved-ask or ordinary ask -> ask; else allow.
   */
  resolve(toolName: string, args?: Record<string, unknown>): ResolveResult {
    const a = args ?? {};

    if (toolName === "run_bash") {
      return this.resolveBash(String(a.command ?? ""));
    }

    const subject = this.relativizeSubject(buildSubject(toolName, a));
    return this.resolveSubject(toolName, subject);
  }

  /**
   * Rewrites a path subject's resolvedPath to be relative to workingDir
   * (e.g. "./src/main.ts") when the path is inside it, so glob rules like
   * "./**" (what migrateLegacyPermissions emits for the old read-in-cwd
   * scope) can actually match — tools always pass absolute paths, and a
   * relative glob pattern can never match one directly. Paths outside
   * workingDir are left as absolute, so they don't spuriously match a
   * "./**"-rooted rule; an absolute glob can still be authored to cover them.
   */
  private relativizeSubject(subject: PermissionSubject): PermissionSubject {
    if (!subject.resolvedPath || !isAbsolute(subject.resolvedPath)) return subject;

    const rel = relative(this.workingDir, subject.resolvedPath);
    if (rel.startsWith("..") || rel === "") return subject;

    return { ...subject, resolvedPath: `./${rel}` };
  }

  private resolveBash(command: string): ResolveResult {
    const { segments, wasUnresolved } = buildBashSubject(command);

    if (segments.length === 0) {
      return { action: "ask", wasUnresolved: true };
    }

    let combined: ResolveResult = this.resolveSubject("run_bash", { tool: "run_bash", text: segments[0] });
    for (const segment of segments.slice(1)) {
      const result = this.resolveSubject("run_bash", { tool: "run_bash", text: segment });
      combined = this.combineMostRestrictive(combined, result);
    }

    // wasUnresolved is fail-closed: it can only push the result toward ask,
    // never let it resolve weaker than ask (an actual deny still wins outright).
    const finalAction = wasUnresolved && combined.action === "allow" ? "ask" : combined.action;
    return { action: finalAction, winningRule: combined.winningRule, wasUnresolved: combined.wasUnresolved || wasUnresolved };
  }

  private combineMostRestrictive(a: ResolveResult, b: ResolveResult): ResolveResult {
    const rank: Record<PermissionAction, number> = { deny: 2, ask: 1, allow: 0 };
    if (rank[b.action] > rank[a.action]) return b;
    return a;
  }

  private resolveSubject(toolName: string, subject: PermissionSubject): ResolveResult {
    const allRules = [...BUILTIN_DESTRUCTIVE_RULES, ...this.configRules, ...this.sessionRules];
    const matches = allRules.filter((r) => patternMatches(r, subject));

    if (matches.length === 0) {
      // Only user-configured rules count toward "this tool is recognized" —
      // builtin destructive rules exist for every install regardless of user
      // intent, so they can't be what makes an unconfigured tool "known."
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
  private resolveTier(tierMatches: PermissionRule[], allowMatches: PermissionRule[], tier: PermissionAction): ResolveResult {
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
   * match on its literal subject text. Used by the UI layer when the user
   * approves a call for session/always and no winningRule already exists to
   * approve (e.g. the call fell through to defaultMode with zero matching
   * rules), so approval never defaults to something broader than what was
   * actually asked.
   */
  buildDefaultRule(toolName: string, args?: Record<string, unknown>): PermissionRule {
    const a = args ?? {};
    if (toolName === "run_bash") {
      return { tool: "run_bash", kind: "exact", pattern: String(a.command ?? ""), action: "allow", origin: "config" };
    }
    const subject = buildSubject(toolName, a);
    return { tool: toolName, kind: "exact", pattern: subject.text, action: "allow", origin: "config" };
  }

  /**
   * Approves `rule` for this process only. Never written to disk, cleared on
   * restart. A destructive-origin match is forced to kind "exact" on the
   * literal subject text — approving one instance never broadens to the
   * whole category.
   */
  approveForSession(rule: PermissionRule, matchedDestructive?: PermissionRule): void {
    const narrowed = matchedDestructive ? this.narrowToExact(rule, matchedDestructive) : rule;
    this.sessionRules.push({ ...narrowed, origin: "session" });
  }

  /**
   * Approves `rule` for this process and persists it to .deepcode/settings.json
   * via an atomic write (temp file + rename). A destructive-origin match is
   * forced to kind "exact" on the literal subject text.
   */
  approveAlways(rule: PermissionRule, matchedDestructive?: PermissionRule): void {
    const narrowed = matchedDestructive ? this.narrowToExact(rule, matchedDestructive) : rule;
    const configRule: PermissionRule = { ...narrowed, origin: "config" };
    this.configRules.push(configRule);
    this.persist();
  }

  private narrowToExact(rule: PermissionRule, matchedDestructive: PermissionRule): PermissionRule {
    if (matchedDestructive.origin !== "builtin-destructive") return rule;
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
