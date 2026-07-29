import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

export interface ProviderModelConfig {
  contextWindow: number;
}

export interface ProviderConfig {
  api: string;
  baseUrl?: string;
  apiKeyEnv?: string | null;
  models?: Record<string, ProviderModelConfig>;
}

export interface CompactionConfig {
  auto?: boolean;
  threshold?: number;
}

export interface KeybindingConfig {
  abort?: string;
  "cycle-approval"?: string;
  "cycle-mode"?: string;
}

export interface McpServerConfig {
  type: "local";
  command: string[];
  enabled: boolean;
}

export type PermissionConfigValue = string | Record<string, string>;

export interface HeirloomConfig {
  provider?: string;
  model?: string;
  providers?: Record<string, ProviderConfig>;
  permissions?: Record<string, PermissionConfigValue>;
  compaction?: CompactionConfig;
  contextWindow?: number;
  keybindings?: KeybindingConfig;
  mcp?: Record<string, McpServerConfig>;
}

export interface LoadResult {
  config: HeirloomConfig;
  warnings: string[];
  errors: string[];
}

const KNOWN_TOP_KEYS = new Set([
  "provider",
  "model",
  "providers",
  "permissions",
  "compaction",
  "contextWindow",
  "keybindings",
  "mcp",
]);

const RESERVED_KEYS = new Set(["ctrl+c", "ctrl+d", "enter", "ctrl+m"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T extends Record<string, unknown>>(a: T, b: Record<string, unknown>): T {
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

function loadYamlFile(path: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = yaml.load(content);
    if (parsed === null || parsed === undefined) return {};
    if (!isObject(parsed)) {
      throw new Error(`config file "${path}" must be a YAML mapping, got ${typeof parsed}`);
    }
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function loadConfig(projectDir?: string): LoadResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const globalPath = join(resolveHome(), "config.yaml");
  const projDir = projectDir ?? process.cwd();
  const projectPath = join(projDir, ".heirloom", "config.yaml");

  const globalRaw = loadYamlFile(globalPath);
  const projectRaw = loadYamlFile(projectPath);

  let merged: Record<string, unknown> = {};
  if (globalRaw && projectRaw) {
    merged = deepMerge(globalRaw, projectRaw);
  } else if (globalRaw) {
    merged = globalRaw;
  } else if (projectRaw) {
    merged = projectRaw;
  }

  const config: HeirloomConfig = {};

  if ("provider" in merged) {
    if (typeof merged.provider === "string") {
      config.provider = merged.provider;
    } else {
      errors.push(`${globalPath}: provider must be a string`);
    }
  }

  if ("model" in merged) {
    if (typeof merged.model === "string") {
      config.model = merged.model;
    } else {
      errors.push(`${globalPath}: model must be a string`);
    }
  }

  if ("providers" in merged) {
    if (isObject(merged.providers)) {
      const entries = merged.providers as Record<string, unknown>;
      const validated: Record<string, ProviderConfig> = {};
      for (const [name, entry] of Object.entries(entries)) {
        if (!isObject(entry)) {
          errors.push(`config.providers.${name}: must be an object`);
          continue;
        }
        const e = entry as Record<string, unknown>;
        const pc: ProviderConfig = { api: "" };
        if (typeof e.api !== "string") {
          errors.push(`config.providers.${name}.api: missing or not a string`);
        } else {
          pc.api = e.api;
        }
        if ("baseUrl" in e) {
          if (typeof e.baseUrl === "string" || e.baseUrl === null) {
            pc.baseUrl = e.baseUrl ?? undefined;
          } else {
            errors.push(`config.providers.${name}.baseUrl: must be a string or null`);
          }
        }
        if ("apiKeyEnv" in e) {
          if (typeof e.apiKeyEnv === "string" || e.apiKeyEnv === null) {
            pc.apiKeyEnv = e.apiKeyEnv ?? undefined;
          } else {
            errors.push(`config.providers.${name}.apiKeyEnv: must be a string or null`);
          }
        }
        if ("models" in e) {
          if (isObject(e.models)) {
            const models: Record<string, ProviderModelConfig> = {};
            for (const [mName, mEntry] of Object.entries(e.models as Record<string, unknown>)) {
              if (!isObject(mEntry)) {
                errors.push(`config.providers.${name}.models.${mName}: must be an object`);
                continue;
              }
              if (typeof (mEntry as Record<string, unknown>).contextWindow !== "number") {
                errors.push(
                  `config.providers.${name}.models.${mName}.contextWindow: must be a number`,
                );
                continue;
              }
              models[mName] = { contextWindow: (mEntry as Record<string, unknown>).contextWindow as number };
            }
            pc.models = models;
          } else {
            errors.push(`config.providers.${name}.models: must be an object`);
          }
        }
        validated[name] = pc;
      }
      config.providers = validated;
    } else {
      errors.push("config.providers: must be an object");
    }
  }

  if ("permissions" in merged) {
    if (isObject(merged.permissions)) {
      config.permissions = merged.permissions as Record<string, PermissionConfigValue>;
    } else {
      errors.push("config.permissions: must be an object");
    }
  }

  if ("compaction" in merged) {
    if (isObject(merged.compaction)) {
      const comp = merged.compaction as Record<string, unknown>;
      const compConfig: CompactionConfig = {};
      if ("auto" in comp) {
        if (typeof comp.auto === "boolean") {
          compConfig.auto = comp.auto;
        } else {
          errors.push("config.compaction.auto: must be boolean");
        }
      }
      if ("threshold" in comp) {
        if (typeof comp.threshold === "number" && comp.threshold >= 0 && comp.threshold <= 1) {
          compConfig.threshold = comp.threshold;
        } else {
          errors.push("config.compaction.threshold: must be a number between 0.0 and 1.0");
        }
      }
      config.compaction = compConfig;
    } else {
      errors.push("config.compaction: must be an object");
    }
  }

  if ("contextWindow" in merged) {
    if (typeof merged.contextWindow === "number") {
      config.contextWindow = merged.contextWindow;
    } else {
      errors.push("config.contextWindow: must be a number");
    }
  }

  if ("keybindings" in merged) {
    if (isObject(merged.keybindings)) {
      const kb = merged.keybindings as Record<string, unknown>;
      const kbc: KeybindingConfig = {};
      for (const [key, value] of Object.entries(kb)) {
        if (typeof value !== "string") {
          errors.push(`config.keybindings.${key}: must be a string`);
          continue;
        }
        if (RESERVED_KEYS.has(value)) {
          errors.push(`config.keybindings.${key}: "${value}" is a reserved keybinding`);
          continue;
        }
        kbc[key as keyof KeybindingConfig] = value;
      }
      config.keybindings = kbc;
    } else {
      errors.push("config.keybindings: must be an object");
    }
  }

  if ("mcp" in merged) {
    if (isObject(merged.mcp)) {
      config.mcp = merged.mcp as Record<string, McpServerConfig>;
    } else {
      errors.push("config.mcp: must be an object");
    }
  }

  for (const key of Object.keys(merged)) {
    if (!KNOWN_TOP_KEYS.has(key)) {
      warnings.push(`config: unknown field "${key}"`);
    }
  }

  return { config, warnings, errors };
}
