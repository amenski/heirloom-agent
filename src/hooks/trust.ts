import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveHome } from "../config/loader.js";

/**
 * Trust-on-first-use store for project-declared hooks (docs/hooks-spec.md §6).
 * Mirrors skill-trust.json: a JSON file under ~/.heirloom (HEIRLOOM_HOME
 * honored, same as every other user-level file) keyed by a hash of the
 * `event|command` pair, so the trust file never echoes command text it would
 * otherwise not need to hold. Global-settings hooks never consult this store —
 * they are trusted implicitly.
 *
 * Unlike skills (which auto-trust on first sight and only *notify*), an unseen
 * project hook requires an explicit ask-tier confirmation before it ever runs:
 * y = trust forever (persisted), n = skip this session.
 */

export interface TrustEntry {
  event: string;
  command: string;
  hash: string;
  firstSeen: number;
  trusted: boolean;
}

export interface TrustStore {
  hooks: Record<string, TrustEntry>;
}

function trustFilePath(): string {
  return `${resolveHome()}/hooks-trust.json`;
}

export function loadHookTrust(): TrustStore {
  const path = trustFilePath();
  if (!existsSync(path)) return { hooks: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.hooks && typeof parsed.hooks === "object") {
      return parsed as TrustStore;
    }
    return { hooks: {} };
  } catch {
    return { hooks: {} };
  }
}

export function saveHookTrust(store: TrustStore): void {
  const path = trustFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
}

export function hookPairHash(event: string, command: string): string {
  return createHash("sha256").update(`${event}|${command}`).digest("hex").slice(0, 16);
}

export function isHookTrusted(store: TrustStore, hash: string): boolean {
  return store.hooks[hash]?.trusted === true;
}
