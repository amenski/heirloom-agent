import { createInterface } from "node:readline/promises";
import { writeFile, readFile, chmod, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BUILTIN_PRESETS } from "../providers/presets.js";
import { readHiddenLine } from "./hidden-input.js";

// Resolved lazily so tests can mock `homedir()` (the value is read per call,
// not baked in at module load).
function credsDir(): string {
  return join(homedir(), ".heirloom");
}
function credsFile(): string {
  return join(credsDir(), "credentials.yaml");
}

const WIZARD_PRESETS: { name: string; keyEnv: string }[] = [
  { name: "deepseek",   keyEnv: "DEEPSEEK_API_KEY" },
  { name: "openai",     keyEnv: "OPENAI_API_KEY" },
  { name: "openrouter", keyEnv: "OPENROUTER_API_KEY" },
  { name: "groq",       keyEnv: "GROQ_API_KEY" },
  { name: "ollama",     keyEnv: "" },
  { name: "anthropic",  keyEnv: "ANTHROPIC_API_KEY" },
  { name: "together",   keyEnv: "TOGETHER_API_KEY" },
];

export interface CredentialEntry {
  key: string;
  source: "env" | "credentials" | "none";
}

async function readCredentials(): Promise<Record<string, string>> {
  const file = credsFile();
  if (!existsSync(file)) return {};

  const perms = (await stat(file)).mode & 0o777;
  if (perms !== 0o600) {
    console.warn(
      `warning: ${file} permissions are ${perms.toString(8)}, expected 600. Fixing.`,
    );
    await chmod(file, 0o600);
  }

  const raw = await readFile(file, "utf-8");
  return parseFlatYaml(raw);
}

function parseFlatYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

async function writeCredentials(creds: Record<string, string>): Promise<void> {
  const dir = credsDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  const lines = Object.entries(creds).map(([k, v]) => `${k}: ${v}`);
  await writeFile(credsFile(), lines.join("\n") + "\n", { mode: 0o600 });
}

/**
 * Persist a single provider's key to ~/.heirloom/credentials.yaml (0600),
 * preserving any existing entries. Shared by the interactive wizard and the
 * non-interactive (`--api-key` / piped-stdin) paths.
 */
export async function authSaveKey(name: string, key: string): Promise<void> {
  const existing = await readCredentials();
  existing[name] = key;
  await writeCredentials(existing);

  console.log(`API key for ${name} saved to ${credsFile()}`);
  console.log("Run `heirloom` to start.");
}

export async function authWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("Available presets:");
  WIZARD_PRESETS.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}`));
  console.log(`  ${WIZARD_PRESETS.length + 1}. custom`);

  let name: string;
  const choice = await rl.question("\nSelect a preset (1-8): ");
  const idx = parseInt(choice, 10);

  if (idx >= 1 && idx <= WIZARD_PRESETS.length) {
    name = WIZARD_PRESETS[idx - 1].name;
  } else if (idx === WIZARD_PRESETS.length + 1) {
    name = await rl.question("Provider name (e.g. my-llm): ");
    name = name.trim();
    if (!name) {
      console.log("Name cannot be empty.");
      rl.close();
      return;
    }
  } else {
    console.log("Invalid selection.");
    rl.close();
    return;
  }

  // Close the readline interface before switching stdin into raw mode for the
  // masked key prompt — the two cannot both own stdin at once.
  rl.close();

  const key = await readHiddenLine(`Paste your API key for ${name}: `);
  if (key === null) {
    console.log("Cancelled. No credentials saved.");
    return;
  }
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    console.log("API key cannot be empty.");
    return;
  }

  await authSaveKey(name, trimmedKey);
}

export async function authList(): Promise<void> {
  const creds = await readCredentials();

  const allPresets = new Map<string, string>();
  for (const p of WIZARD_PRESETS) {
    allPresets.set(p.name, p.keyEnv);
  }

  for (const name of Object.keys(creds)) {
    if (!allPresets.has(name)) allPresets.set(name, "");
  }

  if (allPresets.size === 0) {
    console.log("No providers configured.");
    return;
  }

  for (const [name, keyEnv] of allPresets) {
    const envSet = keyEnv && process.env[keyEnv];
    const hasCreds = name in creds;
    let source = "none";
    if (envSet) source = "env";
    else if (hasCreds) source = "credentials";
    console.log(`  ${name.padEnd(15)} ${source}`);
  }
}

export async function authLogout(name: string): Promise<void> {
  if (!existsSync(credsFile())) {
    console.log(`No credentials file found at ${credsFile()}. Nothing to remove.`);
    return;
  }

  const creds = await readCredentials();
  if (!(name in creds)) {
    console.log(`No credentials saved for "${name}".`);
    return;
  }

  delete creds[name];
  await writeCredentials(creds);
  console.log(`Removed credentials for "${name}".`);
}
