import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export type PermissionScope =
  | "read-in-cwd"
  | "read-out-cwd"
  | "write-in-cwd"
  | "write-out-cwd"
  | "delete-in-cwd"
  | "delete-out-cwd"
  | "query-git-log"
  | "mutate-git-log"
  | "network"
  | "mcp";

export interface PermissionConfig {
  /** Scopes to always allow */
  allow?: PermissionScope[];
  /** Scopes to always deny */
  deny?: PermissionScope[];
  /** Scopes to always ask */
  ask?: PermissionScope[];
  /** Default mode for unlisted scopes: "allowAll" or "askAll" (default "askAll") */
  defaultMode?: "allowAll" | "askAll";
}

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

  // ── Debug / Telemetry ──
  debugLogEnabled?: boolean;
  telemetryEnabled?: boolean;

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
    gitStatus?: boolean;
    gitPollInterval?: number;
    gitCommands?: boolean;
    detectBuildTools?: boolean;
  };
  /** Compaction settings (heirloom extension) */
  compaction?: {
    auto?: boolean;
    threshold?: number;
  };
  /** Context window override (heirloom extension) */
  contextWindow?: number;
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
  return process.env.DEEPCODE_HOME || join(homedir(), ".deepcode");
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
  "permissions",
  "mcpServers",
  "notify",
  "webSearchTool",
  "enabledSkills",
  "debugLogEnabled",
  "telemetryEnabled",
  "temperature",
  // Heirloom extensions
  "provider",
  "theme",
  "keybindings",
  "workflow",
  "compaction",
  "contextWindow",
]);

const VALID_PERMISSION_SCOPES: Set<string> = new Set([
  "read-in-cwd",
  "read-out-cwd",
  "write-in-cwd",
  "write-out-cwd",
  "delete-in-cwd",
  "delete-out-cwd",
  "query-git-log",
  "mutate-git-log",
  "network",
  "mcp",
]);

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

  for (const arrKey of ["allow", "deny", "ask"] as const) {
    if (arrKey in p) {
      if (Array.isArray(p[arrKey])) {
        const arr = p[arrKey] as unknown[];
        const scopes: PermissionScope[] = [];
        for (const item of arr) {
          if (typeof item === "string" && VALID_PERMISSION_SCOPES.has(item)) {
            scopes.push(item as PermissionScope);
          } else {
            errors.push(
              `${source}: permissions.${arrKey} contains invalid scope "${item}"`,
            );
          }
        }
        result[arrKey] = scopes;
      } else {
        errors.push(
          `${source}: permissions.${arrKey} must be an array of strings`,
        );
      }
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

// ── Main loader ──

export function loadConfig(projectDir?: string): LoadResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const globalPath = join(resolveHome(), "settings.json");
  const projDir = projectDir ?? process.cwd();
  const projectPath = join(projDir, ".deepcode", "settings.json");

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
    const perms = validatePermissions(merged.permissions, "config", errors);
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

  // ── webSearchTool ──
  if ("webSearchTool" in merged) {
    if (typeof merged.webSearchTool === "string") {
      config.webSearchTool = merged.webSearchTool;
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

  // ── debugLogEnabled ──
  if ("debugLogEnabled" in merged) {
    if (typeof merged.debugLogEnabled === "boolean") {
      config.debugLogEnabled = merged.debugLogEnabled;
    } else {
      errors.push("config.debugLogEnabled: must be a boolean");
    }
  }

  // ── telemetryEnabled ──
  if ("telemetryEnabled" in merged) {
    if (typeof merged.telemetryEnabled === "boolean") {
      config.telemetryEnabled = merged.telemetryEnabled;
    } else {
      errors.push("config.telemetryEnabled: must be a boolean");
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

  // ── Unknown field warnings ──
  for (const key of Object.keys(merged)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`config: unknown field "${key}"`);
    }
  }

  return { config, warnings, errors };
}
