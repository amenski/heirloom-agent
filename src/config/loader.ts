import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionConfig, PermissionRule, PatternKind, PermissionAction } from "../permissions/index.js";

// ── Deep Code settings.json schema ──

export interface DeepCodeEnv {
  /** Model name, e.g. "deepseek-v4-pro" */
  MODEL?: string;
  /** API base URL, e.g. "https://api.deepseek.com" */
  BASE_URL?: string;
  /** API key */
  API_KEY?: string;
  /** Temperature for chat completions (as string "0"-"2") */
  TEMPERATURE?: string;
  /** Enable thinking mode ("true"/"false") */
  THINKING_ENABLED?: string;
  /** Reasoning effort ("high" or "max") */
  REASONING_EFFORT?: string;
  /** Enable debug logging ("true"/"false") */
  DEBUG_LOG_ENABLED?: string;
  /** Enable telemetry ("true"/"false") */
  TELEMETRY_ENABLED?: string;
  /** Custom env vars */
  [key: string]: string | undefined;
}

export type { PermissionConfig };

export interface McpServerConfig {
  /** Executable path or command (e.g. "npx", "node", "python") */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Environment variables for the MCP server process */
  env?: Record<string, string>;
}

export interface DeepCodeSettings {
  // ── Env (model/api config) ──
  env?: DeepCodeEnv;

  // ── Top-level model / thinking settings ──
  /** Model name (higher priority than env.MODEL) */
  model?: string;
  /** Enable thinking mode (default true for DeepSeek V4) */
  thinkingEnabled?: boolean;
  /**
   * How often the UI repaints. Slower emulators (IntelliJ's terminal, tmux
   * over a slow link) paint every write, so a high refresh rate reads as
   * continuous flicker. See ui/core/refresh-rates for measured traffic.
   */
  refresh?: "fast" | "balanced" | "slow";
  /** Reasoning effort: "high" or "max" (default "max") */
  reasoningEffort?: "high" | "max";

  // ── Permissions ──
  permissions?: PermissionConfig;

  // ── MCP Servers ──
  mcpServers?: Record<string, McpServerConfig>;

  // ── Notify ──
  /** Path to notification script */
  notify?: string;

  // ── Web Search ──
  /** Path to custom web search script */
  webSearchTool?: string;

  // ── Skills ──
  /** Per-skill enable/disable */
  enabledSkills?: Record<string, boolean>;

  // ── Debug (deprecated — use the --debug CLI flag) ──
  debugLogEnabled?: boolean;

  // ── MCP hardening ──
  /** When true, only allowlisted MCP server commands may be spawned (default false) */
  strictMcpConfig?: boolean;

  // ── Temperature ──
  temperature?: number;

  // ── Heirloom extended fields (kept for backward compat, not in Deep Code) ──
  /** Provider name (heirloom extension — maps env settings to AI SDK provider) */
  provider?: string;
  /** Theme config (heirloom extension) */
  theme?: {
    mode?: "dark" | "light" | "auto";
    name?: string;
    overrides?: Record<string, unknown>;
  };
  /** Keybinding config (heirloom extension) */
  keybindings?: Record<string, unknown>;
  /** Workflow integration (heirloom extension) */
  workflow?: {
    /** Enable the git-status poller (default true) */
    gitStatus?: boolean;
    /** Git-status poll interval in ms (default 30000; 0 = on-demand only) */
    gitPollInterval?: number;
    /** @deprecated ignored — no git-command subsystem consumes it */
    gitCommands?: boolean;
    /** @deprecated ignored — no build-tool detection subsystem consumes it */
    detectBuildTools?: boolean;
  };
  /** Compaction settings (heirloom extension) */
  compaction?: {
    auto?: boolean;
    threshold?: number;
  };
  /** Context window override (heirloom extension) */
  contextWindow?: number;
  /** Status line provider plugins (heirloom extension, deepcode-compatible) */
  statusline?: StatuslineConfig;
  /** Favorited models in the /model picker, as "provider/model" ids (heirloom extension) */
  favoriteModels?: string[];
  /** Recently-switched-to models in the /model picker, newest first, capped at 5 (heirloom extension) */
  recentModels?: { id: string; at: number }[];
}

// ── Statusline config (deepcode-compatible) ──

export interface StatuslineCommandProvider {
  type: "command";
  id: string;
  command: string;
  color?: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface StatuslineModuleProvider {
  type: "module";
  id: string;
  path: string;
  color?: string;
}

export type StatuslineProvider = StatuslineCommandProvider | StatuslineModuleProvider;

export interface StatuslineConfig {
  enabled: boolean;
  refreshMs: number;
  separator: string;
  providers: StatuslineProvider[];
}

export interface LoadResult {
  config: DeepCodeSettings;
  warnings: string[];
  errors: string[];
}

// ── Helpers ──

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T extends Record<string, unknown>>(
  a: T,
  b: Record<string, unknown>,
): T {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    const bv = b[key];
    const av = result[key] as unknown;
    if (isObject(av) && isObject(bv)) {
      (result as Record<string, unknown>)[key] = deepMerge(
        av as Record<string, unknown>,
        bv,
      );
    } else {
      (result as Record<string, unknown>)[key] = bv;
    }
  }
  return result;
}

function resolveHome(): string {
  return process.env.HEIRLOOM_HOME || join(homedir(), ".heirloom");
}

function loadJsonFile(path: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed === null || parsed === undefined) return {};
    if (!isObject(parsed)) {
      throw new Error(
        `config file "${path}" must be a JSON object, got ${typeof parsed}`,
      );
    }
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ── Known top-level keys (for unknown-field warnings) ──

const KNOWN_KEYS = new Set([
  "env",
  "model",
  "thinkingEnabled",
  "reasoningEffort",
  "refresh",
  "permissions",
  "mcpServers",
  "notify",
  "webSearchTool",
  "enabledSkills",
  "debugLogEnabled",
  "strictMcpConfig",
  "temperature",
  // Heirloom extensions
  "provider",
  "theme",
  "keybindings",
  "workflow",
  "compaction",
  "contextWindow",
  "statusline",
  "favoriteModels",
  "recentModels",
]);

const VALID_ACTIONS = new Set(["allow", "ask", "deny"]);

function parsePatternKindAndPattern(rawPattern: string): { kind: PatternKind; pattern: string } {
  if (rawPattern.endsWith(":*")) {
    return { kind: "prefix", pattern: rawPattern.slice(0, -2) };
  }
  if (rawPattern.includes("*") || rawPattern.includes("?")) {
    return { kind: "glob", pattern: rawPattern };
  }
  if (rawPattern === "") {
    return { kind: "any", pattern: "" };
  }
  return { kind: "exact", pattern: rawPattern };
}

// ── Validation ──

function validatePermissions(
  perms: unknown,
  source: string,
  errors: string[],
): PermissionConfig | undefined {
  if (!isObject(perms)) {
    errors.push(`${source}: permissions must be an object`);
    return undefined;
  }
  const p = perms as Record<string, unknown>;
  const result: PermissionConfig = {};

  if ("rules" in p) {
    if (Array.isArray(p.rules)) {
      const rules: PermissionRule[] = [];
      for (const item of p.rules as unknown[]) {
        if (!isObject(item)) {
          errors.push(`${source}: permissions.rules contains a non-object entry`);
          continue;
        }
        const r = item as Record<string, unknown>;
        if (typeof r.tool !== "string") {
          errors.push(`${source}: permissions.rules entry missing string "tool"`);
          continue;
        }
        if (typeof r.pattern !== "string") {
          errors.push(`${source}: permissions.rules entry for tool "${r.tool}" missing string "pattern"`);
          continue;
        }
        if (typeof r.action !== "string" || !VALID_ACTIONS.has(r.action)) {
          errors.push(`${source}: permissions.rules entry for tool "${r.tool}" has invalid action "${r.action}"`);
          continue;
        }
        const { kind, pattern } = parsePatternKindAndPattern(r.pattern);
        rules.push({ tool: r.tool, kind, pattern, action: r.action as PermissionAction, origin: "config" });
      }
      result.rules = rules;
    } else {
      errors.push(`${source}: permissions.rules must be an array`);
    }
  }

  if ("defaultMode" in p) {
    if (
      p.defaultMode === "allowAll" ||
      p.defaultMode === "askAll"
    ) {
      result.defaultMode = p.defaultMode;
    } else {
      errors.push(
        `${source}: permissions.defaultMode must be "allowAll" or "askAll"`,
      );
    }
  }

  return result;
}

// ── Legacy scope migration ──

interface LegacyPermissionConfig {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  defaultMode?: "allowAll" | "askAll";
}

const LEGACY_SCOPE_RULES: Record<string, PermissionRule[]> = {
  "read-in-cwd": [{ tool: "read_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" }],
  "read-out-cwd": [{ tool: "read_file", kind: "any", pattern: "", action: "allow", origin: "config" }],
  "write-in-cwd": [{ tool: "write_to_file", kind: "glob", pattern: "./**", action: "allow", origin: "config" }],
  "write-out-cwd": [{ tool: "write_to_file", kind: "any", pattern: "", action: "allow", origin: "config" }],
  "delete-in-cwd": [{ tool: "run_bash", kind: "prefix", pattern: "rm", action: "allow", origin: "config" }],
  "delete-out-cwd": [{ tool: "run_bash", kind: "prefix", pattern: "rm", action: "allow", origin: "config" }],
  "query-git-log": [
    { tool: "run_bash", kind: "prefix", pattern: "git log", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git show", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git diff", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git blame", action: "allow", origin: "config" },
  ],
  "mutate-git-log": [
    { tool: "run_bash", kind: "prefix", pattern: "git commit", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git push", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git rebase", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git merge", action: "allow", origin: "config" },
    { tool: "run_bash", kind: "prefix", pattern: "git reset", action: "allow", origin: "config" },
  ],
  scan: [
    { tool: "glob", kind: "any", pattern: "", action: "allow", origin: "config" },
    { tool: "search", kind: "any", pattern: "", action: "allow", origin: "config" },
  ],
  mcp: [{ tool: "mcp__*", kind: "any", pattern: "", action: "allow", origin: "config" }],
};

export interface MigrationResult {
  rules: PermissionRule[];
  warnings: string[];
}

/**
 * Pure, in-memory translation of the old scope-bucket permission shape into
 * the new rule shape. Never writes to disk — the caller (loadConfig) applies
 * this to the parsed config before returning it; nothing on disk changes
 * until the next real approveAlways() call persists the new shape via an
 * atomic write. Idempotent: a config that already has a `rules` array is
 * returned unchanged (translation is skipped entirely).
 */
export function migrateLegacyPermissions(raw: unknown): MigrationResult {
  if (!isObject(raw)) return { rules: [], warnings: [] };
  const p = raw as Record<string, unknown>;

  if ("rules" in p) return { rules: [], warnings: [] };

  const legacy = p as LegacyPermissionConfig;
  const rules: PermissionRule[] = [];
  const warnings: string[] = [];
  const seenScopes = new Set<string>();

  for (const [scopeList, action] of [
    [legacy.allow, "allow"],
    [legacy.deny, "deny"],
    [legacy.ask, "ask"],
  ] as const) {
    if (!Array.isArray(scopeList)) continue;
    for (const scope of scopeList) {
      seenScopes.add(scope);
      if (scope === "network") {
        warnings.push(
          `permissions: legacy scope "network" has no clean rule-based equivalent (it was triggered by multiple unrelated command types) and was dropped during migration — review and re-add explicit rules if needed`,
        );
        continue;
      }
      const templates = LEGACY_SCOPE_RULES[scope];
      if (!templates) {
        warnings.push(`permissions: unrecognized legacy scope "${scope}" dropped during migration`);
        continue;
      }
      for (const template of templates) {
        rules.push({ ...template, action });
      }
    }
  }

  if (seenScopes.size > 0) {
    warnings.push(
      `permissions: migrated ${seenScopes.size} legacy scope(s) to rule-based permissions — review .heirloom/settings.json and re-approve as needed`,
    );
  }

  return { rules, warnings };
}

function validateMcpServers(
  mcp: unknown,
  source: string,
  errors: string[],
): Record<string, McpServerConfig> | undefined {
  if (!isObject(mcp)) {
    errors.push(`${source}: mcpServers must be an object`);
    return undefined;
  }
  const entries = mcp as Record<string, unknown>;
  const validated: Record<string, McpServerConfig> = {};

  for (const [name, entry] of Object.entries(entries)) {
    if (!isObject(entry)) {
      errors.push(`${source}: mcpServers.${name} must be an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.command !== "string") {
      errors.push(`${source}: mcpServers.${name}.command is required`);
      continue;
    }
    const srv: McpServerConfig = { command: e.command };

    if ("args" in e) {
      if (Array.isArray(e.args)) {
        srv.args = e.args.filter((a): a is string => typeof a === "string");
      } else {
        errors.push(
          `${source}: mcpServers.${name}.args must be an array of strings`,
        );
      }
    }

    if ("env" in e && isObject(e.env)) {
      const env: Record<string, string> = {};
      for (const [ek, ev] of Object.entries(
        e.env as Record<string, unknown>,
      )) {
        if (typeof ev === "string") env[ek] = ev;
      }
      srv.env = env;
    } else if ("env" in e) {
      errors.push(
        `${source}: mcpServers.${name}.env must be an object`,
      );
    }

    validated[name] = srv;
  }

  return validated;
}

function validateStatusline(
  raw: unknown,
  source: string,
  errors: string[],
): StatuslineConfig | undefined {
  if (!isObject(raw)) {
    errors.push(`${source}: statusline must be an object`);
    return undefined;
  }
  const s = raw as Record<string, unknown>;

  // providers (required to do anything; validated first so `enabled` can default)
  const providers: StatuslineProvider[] = [];
  if ("providers" in s) {
    if (!Array.isArray(s.providers)) {
      errors.push(`${source}: statusline.providers must be an array`);
    } else {
      for (const item of s.providers as unknown[]) {
        if (!isObject(item)) {
          errors.push(`${source}: statusline.providers contains a non-object entry`);
          continue;
        }
        const p = item as Record<string, unknown>;
        if (typeof p.id !== "string") {
          errors.push(`${source}: statusline.providers entry missing string "id"`);
          continue;
        }
        if (typeof p.color !== "undefined" && typeof p.color !== "string") {
          errors.push(`${source}: statusline.providers.${p.id}.color must be a string`);
          continue;
        }
        if (p.type === "command") {
          if (typeof p.command !== "string") {
            errors.push(`${source}: statusline.providers.${p.id}.command is required`);
            continue;
          }
          if (typeof p.timeoutMs !== "undefined" && typeof p.timeoutMs !== "number") {
            errors.push(`${source}: statusline.providers.${p.id}.timeoutMs must be a number`);
            continue;
          }
          if (typeof p.cwd !== "undefined" && typeof p.cwd !== "string") {
            errors.push(`${source}: statusline.providers.${p.id}.cwd must be a string`);
            continue;
          }
          providers.push({
            type: "command",
            id: p.id,
            command: p.command,
            ...(typeof p.color === "string" ? { color: p.color } : {}),
            ...(typeof p.timeoutMs === "number" ? { timeoutMs: p.timeoutMs } : {}),
            ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
          });
        } else if (p.type === "module") {
          if (typeof p.path !== "string") {
            errors.push(`${source}: statusline.providers.${p.id}.path is required`);
            continue;
          }
          providers.push({
            type: "module",
            id: p.id,
            path: p.path,
            ...(typeof p.color === "string" ? { color: p.color } : {}),
          });
        } else {
          errors.push(`${source}: statusline.providers.${p.id}.type must be "command" or "module"`);
        }
      }
    }
  }

  // enabled — defaults true when providers exist
  let enabled = providers.length > 0;
  if ("enabled" in s) {
    if (typeof s.enabled === "boolean") {
      enabled = s.enabled;
    } else {
      errors.push(`${source}: statusline.enabled must be a boolean`);
    }
  }

  // refreshMs — min 500, default 2000
  let refreshMs = 2000;
  if ("refreshMs" in s) {
    if (typeof s.refreshMs === "number") {
      refreshMs = Math.max(500, s.refreshMs);
    } else {
      errors.push(`${source}: statusline.refreshMs must be a number`);
    }
  }

  // separator — default " · "
  let separator = " · ";
  if ("separator" in s) {
    if (typeof s.separator === "string") {
      separator = s.separator;
    } else {
      errors.push(`${source}: statusline.separator must be a string`);
    }
  }

  return { enabled, refreshMs, separator, providers };
}

// ── Main loader ──

export function loadConfig(projectDir?: string): LoadResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const globalPath = join(resolveHome(), "settings.json");
  const projDir = projectDir ?? process.cwd();
  const projectPath = join(projDir, ".heirloom", "settings.json");

  const globalRaw = loadJsonFile(globalPath);
  const projectRaw = loadJsonFile(projectPath);

  let merged: Record<string, unknown> = {};
  if (globalRaw && projectRaw) {
    merged = deepMerge(globalRaw, projectRaw);
  } else if (globalRaw) {
    merged = globalRaw;
  } else if (projectRaw) {
    merged = projectRaw;
  }

  const config: DeepCodeSettings = {};

  // ── env block ──
  if ("env" in merged) {
    if (isObject(merged.env)) {
      const env = merged.env as Record<string, unknown>;
      const envConfig: DeepCodeEnv = {};
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") {
          envConfig[key] = value;
        }
      }
      config.env = envConfig;
    } else {
      errors.push("config.env: must be an object");
    }
  }

  // ── model (top-level, higher priority than env.MODEL) ──
  if ("model" in merged) {
    if (typeof merged.model === "string") {
      config.model = merged.model;
    } else {
      errors.push("config.model: must be a string");
    }
  }

  // ── refresh ──
  if ("refresh" in merged) {
    const allowed = ["fast", "balanced", "slow"];
    if (typeof merged.refresh === "string" && allowed.includes(merged.refresh)) {
      config.refresh = merged.refresh as "fast" | "balanced" | "slow";
    } else {
      // refresh is a cosmetic display knob — it only affects repaint cadence,
      // not correctness. A hard error here is disproportionate: it would take
      // loadConfig's errors down the main() exit(1) path over a typo in a
      // setting the user probably doesn't remember the exact spelling of.
      // Warn and fall through to env/default resolution instead.
      warnings.push(
        `config.refresh: "${String(merged.refresh)}" is not one of ${allowed.join(" | ")} — using default`,
      );
    }
  }

  // ── thinkingEnabled ──
  if ("thinkingEnabled" in merged) {
    if (typeof merged.thinkingEnabled === "boolean") {
      config.thinkingEnabled = merged.thinkingEnabled;
    } else {
      errors.push("config.thinkingEnabled: must be a boolean");
    }
  }

  // ── reasoningEffort ──
  if ("reasoningEffort" in merged) {
    if (merged.reasoningEffort === "high" || merged.reasoningEffort === "max") {
      config.reasoningEffort = merged.reasoningEffort;
    } else {
      errors.push('config.reasoningEffort: must be "high" or "max"');
    }
  }

  // ── permissions ──
  if ("permissions" in merged) {
    const permsRaw = isObject(merged.permissions) ? merged.permissions : {};
    const alreadyNewShape = "rules" in permsRaw;

    let permsForValidation: Record<string, unknown> = merged.permissions as Record<string, unknown>;
    if (!alreadyNewShape) {
      const migration = migrateLegacyPermissions(merged.permissions);
      warnings.push(...migration.warnings);
      permsForValidation = { ...permsRaw, rules: migration.rules };
    }

    const perms = validatePermissions(permsForValidation, "config", errors);
    if (perms) config.permissions = perms;
  }

  // ── mcpServers ──
  if ("mcpServers" in merged) {
    const mcp = validateMcpServers(merged.mcpServers, "config", errors);
    if (mcp) config.mcpServers = mcp;
  }

  // ── notify ──
  if ("notify" in merged) {
    if (typeof merged.notify === "string") {
      config.notify = merged.notify;
    } else {
      errors.push("config.notify: must be a string (script path)");
    }
  }

  // ── webSearchTool (deprecated) ──
  if ("webSearchTool" in merged) {
    if (typeof merged.webSearchTool === "string") {
      config.webSearchTool = merged.webSearchTool;
      warnings.push(
        "webSearchTool is deprecated and ignored — use an MCP search server (mcpServers) instead",
      );
    } else {
      errors.push("config.webSearchTool: must be a string (script path)");
    }
  }

  // ── enabledSkills ──
  if ("enabledSkills" in merged) {
    if (isObject(merged.enabledSkills)) {
      const skills: Record<string, boolean> = {};
      for (const [name, value] of Object.entries(
        merged.enabledSkills as Record<string, unknown>,
      )) {
        if (typeof value === "boolean") {
          skills[name] = value;
        } else {
          errors.push(
            `config.enabledSkills.${name}: must be boolean`,
          );
        }
      }
      config.enabledSkills = skills;
    } else {
      errors.push("config.enabledSkills: must be an object");
    }
  }

  // ── debugLogEnabled (deprecated) ──
  if ("debugLogEnabled" in merged) {
    if (typeof merged.debugLogEnabled === "boolean") {
      config.debugLogEnabled = merged.debugLogEnabled;
      warnings.push(
        "debugLogEnabled is deprecated and ignored — use the --debug flag",
      );
    } else {
      errors.push("config.debugLogEnabled: must be a boolean");
    }
  }

  // ── strictMcpConfig ──
  if ("strictMcpConfig" in merged) {
    if (typeof merged.strictMcpConfig === "boolean") {
      config.strictMcpConfig = merged.strictMcpConfig;
    } else {
      errors.push("config.strictMcpConfig: must be a boolean");
    }
  }

  // ── temperature ──
  if ("temperature" in merged) {
    if (typeof merged.temperature === "number") {
      if (merged.temperature >= 0 && merged.temperature <= 2) {
        config.temperature = merged.temperature;
      } else {
        errors.push("config.temperature: must be between 0 and 2");
      }
    } else {
      errors.push("config.temperature: must be a number");
    }
  }

  // ── Heirloom extended fields (backward compat) ──

  // provider
  if ("provider" in merged) {
    if (typeof merged.provider === "string") {
      config.provider = merged.provider;
    } else {
      errors.push("config.provider: must be a string");
    }
  }

  // theme
  if ("theme" in merged) {
    if (isObject(merged.theme)) {
      const t = merged.theme as Record<string, unknown>;
      const themeConfig: DeepCodeSettings["theme"] = { mode: "dark" };
      if ("mode" in t && typeof t.mode === "string") {
        const mode = t.mode;
        if (mode === "dark" || mode === "light" || mode === "auto") {
          themeConfig.mode = mode;
        } else {
          themeConfig.mode = "dark";
          themeConfig.name = mode;
        }
      }
      if ("overrides" in t && isObject(t.overrides)) {
        themeConfig.overrides = t.overrides as Record<string, unknown>;
      }
      config.theme = themeConfig;
    } else {
      errors.push("config.theme: must be an object");
    }
  }

  // keybindings (pass through as-is for now)
  if ("keybindings" in merged) {
    if (isObject(merged.keybindings)) {
      config.keybindings = merged.keybindings as Record<string, unknown>;
    } else {
      errors.push("config.keybindings: must be an object");
    }
  }

  // workflow
  if ("workflow" in merged) {
    if (isObject(merged.workflow)) {
      config.workflow = merged.workflow as DeepCodeSettings["workflow"];
      const wf = merged.workflow as Record<string, unknown>;
      if ("gitCommands" in wf) {
        warnings.push(
          "workflow.gitCommands is deprecated and ignored — no git-command subsystem consumes it",
        );
      }
      if ("detectBuildTools" in wf) {
        warnings.push(
          "workflow.detectBuildTools is deprecated and ignored — no build-tool detection subsystem consumes it",
        );
      }
    } else {
      errors.push("config.workflow: must be an object");
    }
  }

  // compaction
  if ("compaction" in merged) {
    if (isObject(merged.compaction)) {
      config.compaction = merged.compaction as DeepCodeSettings["compaction"];
    } else {
      errors.push("config.compaction: must be an object");
    }
  }

  // contextWindow
  if ("contextWindow" in merged) {
    if (typeof merged.contextWindow === "number") {
      config.contextWindow = merged.contextWindow;
    } else {
      errors.push("config.contextWindow: must be a number");
    }
  }

  // statusline
  if ("statusline" in merged) {
    const statusline = validateStatusline(merged.statusline, "config", errors);
    if (statusline) config.statusline = statusline;
  }

  // favoriteModels
  if ("favoriteModels" in merged) {
    if (Array.isArray(merged.favoriteModels)) {
      config.favoriteModels = merged.favoriteModels.filter((f): f is string => typeof f === "string");
      if (config.favoriteModels.length !== merged.favoriteModels.length) {
        errors.push("config.favoriteModels: all entries must be strings");
      }
    } else {
      errors.push("config.favoriteModels: must be an array of strings");
    }
  }

  // recentModels
  if ("recentModels" in merged) {
    if (Array.isArray(merged.recentModels)) {
      const recent: { id: string; at: number }[] = [];
      for (const item of merged.recentModels as unknown[]) {
        if (!isObject(item) || typeof item.id !== "string" || typeof item.at !== "number") {
          errors.push('config.recentModels: entries must be objects of shape { id: string, at: number }');
          continue;
        }
        recent.push({ id: item.id, at: item.at });
      }
      config.recentModels = recent;
    } else {
      errors.push("config.recentModels: must be an array");
    }
  }

  // ── Unknown field warnings ──
  for (const key of Object.keys(merged)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`config: unknown field "${key}"`);
    }
  }

  return { config, warnings, errors };
}
