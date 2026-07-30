import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CREDENTIALS_PATH = join(homedir(), ".deepcode", "credentials.json");

/**
 * Reads the flat `provider: key` map from ~/.deepcode/credentials.json
 * Never throws — a missing or malformed file resolves to an empty map.
 */
export function readCredentialsFile(
  path: string = CREDENTIALS_PATH,
): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (
      parsed === null ||
      parsed === undefined ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** Looks up a single provider's key in the flat credentials map, or undefined if absent/empty. */
export function getCredential(
  name: string,
  path: string = CREDENTIALS_PATH,
): string | undefined {
  const creds = readCredentialsFile(path);
  const value = creds[name];
  return value ? value : undefined;
}
