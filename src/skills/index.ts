import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDef } from "../types.js";
import type { ToolHandler } from "../tools/types.js";
import { checkSkillTrust } from "./trust.js";

export interface SkillDef {
  name: string;
  description: string;
  triggers: string[];
  content: string;
  mode?: string;
  sourcePath: string;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    i++;

    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!topMatch) continue;

    const key = topMatch[1];
    const rest = topMatch[2];

    if (rest === ">" || rest === "|") {
      let value = "";
      while (i < lines.length && /^\s{2,}/.test(lines[i])) {
        value += (value ? " " : "") + lines[i].trim();
        i++;
      }
      result[key] = value;
    } else if (rest === "") {
      const arr: string[] = [];
      while (i < lines.length && /^\s{2}-\s+(.+)$/.test(lines[i])) {
        const matchArr = lines[i].match(/^\s{2}-\s+(.+)$/);
        if (matchArr) arr.push(unquote(matchArr[1].trim()));
        i++;
      }
      if (arr.length > 0) {
        result[key] = arr;
      } else {
        result[key] = "";
      }
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      result[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else if (rest.startsWith('"') && rest.endsWith('"')) {
      result[key] = rest.slice(1, -1);
    } else if (rest.startsWith("'") && rest.endsWith("'")) {
      result[key] = rest.slice(1, -1);
    } else {
      result[key] = rest;
    }
  }

  return result;
}

function parseFrontmatter(
  raw: string
): { frontmatter: Record<string, unknown>; content: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) return null;

  const rest = trimmed.slice(3);
  const endIdx = rest.indexOf("\n---");
  if (endIdx === -1) return null;

  const fmBlock = rest.slice(0, endIdx).trim();
  const body = rest.slice(endIdx + 4).trim();
  const frontmatter = parseYaml(fmBlock);

  return { frontmatter, content: body };
}

async function scanDir(dir: string): Promise<SkillDef[]> {
  const skills: SkillDef[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = join(dir, entry.name, "SKILL.md");
    try {
      const raw = await readFile(skillPath, "utf-8");

      if (raw.trim() === "") {
        console.warn(`[skills] Skipping empty skill file: ${skillPath}`);
        continue;
      }

      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        console.warn(
          `[skills] Invalid SKILL.md (bad frontmatter): ${skillPath}`
        );
        continue;
      }

      const { frontmatter, content } = parsed;

      const name = frontmatter.name as string | undefined;
      if (!name) {
        console.warn(
          `[skills] Invalid SKILL.md (missing name field): ${skillPath}`
        );
        continue;
      }

      const description = (frontmatter.description as string) || "";
      let triggers: string[] = [];
      if (Array.isArray(frontmatter.triggers)) {
        triggers = frontmatter.triggers.map((t) => String(t));
      }
      const mode = (frontmatter.mode as string) || undefined;

      skills.push({ name, description, triggers, content, mode, sourcePath: skillPath });
    } catch (err) {
      console.warn(
        `[skills] Failed to read ${skillPath}: ${(err as Error).message}`
      );
    }
  }

  return skills;
}

/**
 * A skill is enabled unless the config's `enabledSkills` map explicitly sets it
 * to `false`. Absent (or a missing map) means enabled — the default.
 */
export function isSkillEnabled(
  name: string,
  enabledSkills?: Record<string, boolean>,
): boolean {
  return enabledSkills?.[name] !== false;
}

export class SkillLoader {
  async load(options?: {
    headless?: boolean;
    enabledSkills?: Record<string, boolean>;
  }): Promise<SkillDef[]> {
    const allSkills: SkillDef[] = [];
    const seen = new Set<string>();

    const dirs = [
      join(process.cwd(), ".heirloom", "skills"),
      join(process.cwd(), ".agents", "skills"),
      join(homedir(), ".heirloom", "skills"),
      join(homedir(), ".agents", "skills"),
    ];

    for (const dir of dirs) {
      const skills = await scanDir(dir);
      for (const skill of skills) {
        if (!seen.has(skill.name)) {
          if (!isSkillEnabled(skill.name, options?.enabledSkills)) {
            // Explicitly disabled via config.enabledSkills — never index it.
            seen.add(skill.name);
            continue;
          }
          const trustResult = checkSkillTrust(skill.sourcePath, skill.name);

          if (options?.headless && trustResult.status !== "trusted") {
            process.stderr.write(`[warn] Skipping untrusted skill in headless: ${skill.name} (${trustResult.status})\n`);
            continue;
          }

          if (trustResult.status === "new") {
            console.log(`  [skill] ${trustResult.name} loaded (first time) — ${trustResult.sourcePath}`);
          } else if (trustResult.status === "changed") {
            console.log(`  [skill] ${trustResult.name} changed — ${trustResult.sourcePath}`);
          }

          seen.add(skill.name);
          allSkills.push(skill);
        }
      }
    }

    return allSkills;
  }

  match(input: string, skills: SkillDef[]): SkillDef[] {
    const lowerInput = input.toLowerCase();
    const matched: { skill: SkillDef; triggerLen: number }[] = [];

    for (const skill of skills) {
      let bestLen = 0;
      for (const trigger of skill.triggers) {
        if (lowerInput.includes(trigger.toLowerCase())) {
          bestLen = Math.max(bestLen, trigger.length);
        }
      }
      if (bestLen > 0) {
        matched.push({ skill, triggerLen: bestLen });
      }
    }

    matched.sort((a, b) => b.triggerLen - a.triggerLen);
    return matched.map((m) => m.skill);
  }
}

export function createLoadSkillTool(skills: SkillDef[]): { def: ToolDef; handler: ToolHandler } {
  const def: ToolDef = {
    name: "load_skill",
    description: "Load the full content of a skill by name. Returns the skill's instructions.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the skill to load" },
      },
      required: ["name"],
    },
  };

  const handler: ToolHandler = async (args) => {
    const name = args.name as string;
    const skill = skills.find(s => s.name === name);
    if (!skill) {
      const available = skills.map(s => s.name).join(", ");
      return { content: `Unknown skill: ${name}. Available: ${available}`, error: "FILE_NOT_FOUND" };
    }
    return { content: skill.content };
  };

  return { def, handler };
}
