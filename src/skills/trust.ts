import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const TRUST_FILE = join(homedir(), ".heirloom", "skill-trust.json");

interface TrustEntry {
  path: string;
  hash: string;
  firstSeen: number;
  lastChanged?: number;
  trusted: boolean;
}

interface TrustStore {
  skills: Record<string, TrustEntry>;
}

function loadTrustStore(): TrustStore {
  if (!existsSync(TRUST_FILE)) return { skills: {} };
  try {
    return JSON.parse(readFileSync(TRUST_FILE, "utf-8"));
  } catch {
    return { skills: {} };
  }
}

function saveTrustStore(store: TrustStore): void {
  const dir = dirname(TRUST_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(TRUST_FILE, JSON.stringify(store, null, 2));
}

function hashFile(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export type TrustResult =
  | { status: "trusted" }
  | { status: "new"; name: string; sourcePath: string }
  | { status: "changed"; name: string; sourcePath: string };

export function checkSkillTrust(skillPath: string, skillName: string): TrustResult {
  const hash = hashFile(skillPath);
  const store = loadTrustStore();
  const entry = store.skills[skillPath];

  if (!entry) {
    store.skills[skillPath] = { path: skillPath, hash, firstSeen: Date.now(), trusted: true };
    saveTrustStore(store);
    return { status: "new", name: skillName, sourcePath: skillPath };
  }

  if (entry.hash !== hash) {
    entry.hash = hash;
    entry.lastChanged = Date.now();
    saveTrustStore(store);
    return { status: "changed", name: skillName, sourcePath: skillPath };
  }

  return { status: "trusted" };
}
