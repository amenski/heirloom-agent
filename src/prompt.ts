import type { ModeConfig } from "./modes/loader.js";
import type { SkillDef } from "./skills/index.js";
import type { RepoMap } from "./repomap/index.js";
import type { ToolGroup } from "./tools/types.js";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative, sep } from "node:path";
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

  const rules = loadProjectRules(ctx.workingDir);
  if (rules) sections.push(rules);

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

/** Max total bytes of assembled rule content injected into the prompt. */
const MAX_RULES_BYTES = 20 * 1024;

/**
 * Recursively load `.heirloom/rules/**\/*.md` and assemble them into a single
 * "# Project Rules" block. Each file becomes a "### Rule: <scope>" section,
 * where <scope> is the file's path relative to the rules dir without the `.md`
 * suffix (e.g. `rules/api/naming.md` → `api/naming`).
 *
 * Ordering is deterministic: within every directory, files are emitted before
 * subdirectories, each group sorted alphabetically. Empty or unreadable files
 * are skipped. Files that resolve (via symlink) outside the project directory
 * are skipped as a safety measure. Total content is capped at MAX_RULES_BYTES
 * and truncated with a note if exceeded. Returns null when the rules dir is
 * absent or yields no usable content. Rule content is treated as
 * user-authored, at the same trust level as `.heirloom/instructions.md`.
 */
export function loadProjectRules(projectDir: string): string | null {
  const rulesDir = join(projectDir, ".heirloom", "rules");
  if (!existsSync(rulesDir)) return null;

  // Resolve the project root once so symlink-escape checks are stable even if
  // the project path itself contains symlinks.
  let projectRoot: string;
  try {
    projectRoot = realpathSync(projectDir);
  } catch {
    return null;
  }

  const sections: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  // Collect .md files in deterministic order: files-then-dirs, alphabetical
  // within each group, recursing depth-first.
  const walk = (dir: string): void => {
    if (truncated) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }

    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const file of files) {
      if (truncated) return;
      const fullPath = join(dir, file.name);

      // Reject anything that resolves outside the project (symlink escape).
      let realPath: string;
      try {
        realPath = realpathSync(fullPath);
      } catch {
        continue; // dangling symlink or unreadable — skip
      }
      const rel = relative(projectRoot, realPath);
      if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) {
        continue; // escapes the project directory — skip
      }

      let content: string;
      try {
        content = readFileSync(fullPath, "utf-8").trim();
      } catch {
        continue; // unreadable file — skip
      }
      if (!content) continue; // empty file — skip

      const scope = relative(rulesDir, fullPath).slice(0, -3).split(sep).join("/");
      const section = `### Rule: ${scope}\n${content}`;
      const sectionBytes = Buffer.byteLength(section, "utf-8");

      if (totalBytes + sectionBytes > MAX_RULES_BYTES) {
        sections.push("*(Project rules truncated: size cap reached.)*");
        truncated = true;
        return;
      }

      sections.push(section);
      totalBytes += sectionBytes;
    }

    for (const sub of dirs) {
      if (truncated) return;
      walk(join(dir, sub.name));
    }
  };

  walk(rulesDir);

  if (sections.length === 0) return null;
  return `# Project Rules\n${sections.join("\n\n")}`;
}

function getSkillsIndex(skills: SkillDef[]): string {
  const lines = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `- ${s.name}: ${s.description || "no description"}`);
  return `# Available skills\n${lines.join("\n")}`;
}
