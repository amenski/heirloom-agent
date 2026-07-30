import { readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Resolved lazily (per call, not baked in at module load) so tests can mock
// `homedir()`. This is the single source of truth for where credentials live;
// auth/wizard.ts imports these helpers so the write and read paths cannot drift.
export function credsDir(): string {
  return join(homedir(), ".heirloom");
}

export function credsFile(): string {
  return join(credsDir(), "credentials.yaml");
}

/** Legacy JSON store from earlier versions. Read-only fallback; never written. */
export function legacyCredsFile(): string {
  return join(homedir(), ".deepcode", "credentials.json");
}

let legacyWarned = false;

/**
 * Parse a flat `key: value` YAML map (one entry per line). Quotes around the
 * value are stripped; blank lines and `#` comments are ignored. This is the
 * exact shape `heirloom auth` writes.
 */
export function parseFlatYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Read the flat `provider: key` map from `~/.heirloom/credentials.yaml` — the
 * file `heirloom auth` writes. Never throws: a missing or unreadable file
 * resolves to an empty map. If the file's permissions are looser than 0600 they
 * are fixed in place (a warning is printed).
 */
export function readCredentialsFile(
  path: string = credsFile(),
): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const perms = statSync(path).mode & 0o777;
    if (perms !== 0o600) {
      console.warn(
        `warning: ${path} permissions are ${perms.toString(8)}, expected 600. Fixing.`,
      );
      chmodSync(path, 0o600);
    }
    return parseFlatYaml(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/** Read the legacy JSON store, if present. Never throws; empty map on any error. */
function readLegacyCredentialsFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Look up a single provider's key. Reads the canonical
 * `~/.heirloom/credentials.yaml` first; if the key is absent there and a legacy
 * `~/.deepcode/credentials.json` still exists, falls back to it with a one-time
 * deprecation note on stderr. Returns undefined when absent/empty in both.
 */
export function getCredential(
  name: string,
  path: string = credsFile(),
  legacyPath: string = legacyCredsFile(),
): string | undefined {
  const value = readCredentialsFile(path)[name];
  if (value) return value;

  const legacy = readLegacyCredentialsFile(legacyPath)[name];
  if (legacy) {
    if (!legacyWarned) {
      legacyWarned = true;
      console.warn(
        `warning: read "${name}" from legacy ${legacyPath}. This location is deprecated; run \`heirloom auth\` to migrate to ${credsFile()}.`,
      );
    }
    return legacy;
  }
  return undefined;
}
