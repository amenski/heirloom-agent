import type { ModeConfig } from "./modes/loader.js";
import type { SkillDef } from "./skills/index.js";
import type { RepoMap } from "./repomap/index.js";
import type { ToolGroup } from "./tools/types.js";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { platform } from "node:os";

export interface PromptContext {
  mode?: ModeConfig;
  workingDir: string;
  skills?: SkillDef[];
  repomap?: RepoMap;
  memory?: string;
  conversation?: string;
  planMode?: boolean;
}

/**
 * The cacheable part of the system prompt: role, base rules, tool guide, mode
 * custom instructions, project instructions, skills index, memory. These only
 * change on mode/skill/config/memory change, so they form the stable prefix
 * that providers cache across turns. Must be byte-stable given the same
 * inputs — list-derived content (skills) is sorted for determinism.
 */
export function buildStablePreamble(ctx: PromptContext): string {
  const sections: string[] = [];
  const mode = ctx.mode;

  if (mode) {
    sections.push(mode.roleDefinition);
  } else {
    sections.push("You are Heirloom, a helpful AI coding assistant.");
  }

  sections.push(getBaseRules());

  const toolGuide = getToolGuide(mode?.groups || []);
  if (toolGuide) sections.push(toolGuide);

  if (mode?.customInstructions) sections.push(mode.customInstructions);

  const proj = getProjectInstructions(ctx.workingDir);
  if (proj) sections.push(proj);

  if (ctx.skills && ctx.skills.length > 0) {
    sections.push(getSkillsIndex(ctx.skills));
  }

  if (ctx.memory) sections.push(ctx.memory);

  return sections.join("\n\n");
}

/**
 * The per-turn part of the system prompt: plan-mode instruction, environment
 * (git/date), and the RepoMap (keyed on the latest user message). Rebuilt
 * every turn — cheap, and must never be baked into the cached stable prefix.
 */
export async function buildVolatileContext(ctx: PromptContext): Promise<string> {
  const sections: string[] = [];

  if (ctx.planMode) {
    sections.push(
      "You are in planning mode. Do NOT execute any tool calls that modify files. " +
      "Instead, analyze the request and produce a detailed plan. " +
      "Your reply must end with a <proposed_plan>...</proposed_plan> block containing the step-by-step plan."
    );
  }

  const env = getEnvironment(ctx.workingDir);
  if (env) sections.push(env);

  if (ctx.repomap && ctx.conversation) {
    const map = await ctx.repomap.getMap(ctx.conversation, 1024);
    if (map && map !== "(empty repository)") {
      sections.push("# Repository map\n" + map);
    }
  }

  return sections.join("\n\n");
}

export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const stable = buildStablePreamble(ctx);
  const volatile = await buildVolatileContext(ctx);
  return [stable, volatile].filter(Boolean).join("\n\n");
}

function getBaseRules(): string {
  return `You are Heirloom, a coding agent operating on the user's repository through tools.

# Working rules
- Read before you write: never edit a file you have not read this session.
- Use absolute paths in every tool call.
- Make the smallest change that solves the problem. Do not refactor adjacent code, reformat untouched lines, or add features beyond what was asked.
- After changing code, verify it: run the project's typecheck or tests when they exist.
- If a tool call fails, read the error and change your approach. Never repeat an identical failing call.
- If the request is ambiguous, state your assumption in one line and proceed. Ask only when a wrong guess would be expensive to undo.
- Never invent file contents, APIs, or command output. Look it up with tools.

# Output
- Lead with the result. No preamble, no restating the question, no apologies.
- Reference code as path:line.
- When you finish, summarize what changed in one or two sentences.`;
}

function getToolGuide(groups: ToolGroup[]): string {
  if (groups.includes("workflow")) return "";

  const hasEdit = groups.includes("edit");
  const hasCommand = groups.includes("command");

  if (!hasEdit && !hasCommand) return "";

  const parts: string[] = [];

  if (hasEdit) {
    parts.push(`# Choosing an edit tool
- edit — the default. One exact string → one replacement. The old string must match the file byte-for-byte (whitespace included) and be unique in the file.
- edit_file — like edit, but you state how many occurrences you expect; fails if the count differs. Use when the string may not be unique.
- search_replace — replace every occurrence in one file.
- apply_diff — apply a unified diff to one file. Use when you already think in diff form.
- apply_patch — one unified diff spanning multiple files. Use for a single logical change that touches several files.
- write_to_file — create a new file, or rewrite one where most of the content changes.

Pick the smallest tool that expresses the change. Never write_to_file to change a few lines. When an edit fails to match, re-read the file — do not guess at whitespace.`);
  }

  if (hasCommand) {
    parts.push(`# Shell
- Non-interactive only: no editors, no pagers, no prompts (use git --no-pager, npm --yes where needed).
- Quote paths with spaces.
- Destructive commands (rm, git reset --hard, force-push, DROP) only when the user explicitly asked for that outcome.`);
  }

  return parts.join("\n\n");
}

function getEnvironment(cwd: string): string {
  const date = new Date().toISOString().slice(0, 10);

  let gitLine = "not a git repository";
  try {
    const branch = execSync("git branch --show-current", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const status = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const fileCount = status.trim().split("\n").filter(Boolean).length;
    const statusStr = fileCount === 0 ? "clean" : `${fileCount} files modified`;
    if (branch) {
      gitLine = `${branch} (${statusStr})`;
    }
  } catch {
    // not a git repository — leave gitLine as default
  }

  return `# Environment
cwd: ${cwd}
platform: ${platform()}
date: ${date}
git: ${gitLine}`;
}

function getProjectInstructions(cwd: string): string {
  const heirloomPath = join(cwd, ".heirloom", "instructions.md");
  if (existsSync(heirloomPath)) {
    const content = readFileSync(heirloomPath, "utf-8").trim();
    if (content) return `# Project instructions\n${content}`;
  }

  const agentsPath = join(cwd, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, "utf-8").trim();
    if (content) return `# Project instructions\n${content}`;
  }

  return "";
}

function getSkillsIndex(skills: SkillDef[]): string {
  const lines = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `- ${s.name}: ${s.description || "no description"}`);
  return `# Available skills\n${lines.join("\n")}`;
}
