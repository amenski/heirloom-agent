import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const MAX_INJECTION_TOKENS = 1024;

function slugify(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
}

export class MemoryStore {
  private projectSlug: string;
  private memoryDir: string;
  private projectDir: string;

  constructor(workspaceDir?: string) {
    const cwd = workspaceDir ?? process.cwd();
    this.projectSlug = slugify(cwd);
    this.memoryDir = join(homedir(), ".heirloom", "memory");
    this.projectDir = join(this.memoryDir, this.projectSlug);
  }

  async init(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true });
    await mkdir(join(this.memoryDir, "_global"), { recursive: true });

    const indexFile = join(this.memoryDir, "MEMORY.md");
    if (!existsSync(indexFile)) {
      await writeFile(indexFile, "# Memory Index\n\n");
    }
  }

  async appendSession(entries: {
    date: string;
    tasks: string[];
    decisions: string[];
    files: string[];
    summary?: string;
  }): Promise<void> {
    const file = join(this.projectDir, "sessions.md");
    const header = `## ${entries.date}\n`;
    let body = "";
    if (entries.tasks.length > 0)
      body += `- Tasks: ${entries.tasks.join(", ")}\n`;
    if (entries.decisions.length > 0)
      body += `- Decisions:\n${entries.decisions.map((d) => `  - ${d}`).join("\n")}\n`;
    if (entries.files.length > 0)
      body += `- Files: ${entries.files.join(", ")}\n`;
    if (entries.summary)
      body += `- Summary: ${entries.summary}\n`;

    let existing = "";
    try {
      existing = await readFile(file, "utf-8");
    } catch {
      // file does not exist yet
    }
    await writeFile(file, header + body + "\n" + existing);
  }

  async writeFact(
    category: "decisions" | "patterns" | "pitfalls",
    fact: string,
  ): Promise<void> {
    const file = join(this.projectDir, `${category}.md`);
    const timestamp = new Date().toISOString();
    const entry = `- [${timestamp}] ${fact}\n`;
    await appendFile(file, entry);
  }

  async getInjection(
    maxTokens: number = MAX_INJECTION_TOKENS,
  ): Promise<string | null> {
    const indexFile = join(this.memoryDir, "MEMORY.md");
    let indexContent = "";
    try {
      indexContent = await readFile(indexFile, "utf-8");
    } catch {
      return null;
    }

    const parts: string[] = [];
    parts.push(
      indexContent.split("\n").slice(0, 20).join("\n"),
    );

    const files = ["sessions.md", "decisions.md", "patterns.md", "pitfalls.md"];
    let tokenBudget = maxTokens - Math.ceil(indexContent.length / 4);

    for (const f of files) {
      const fp = join(this.projectDir, f);
      try {
        const content = await readFile(fp, "utf-8");
        const tokens = Math.ceil(content.length / 4);
        if (tokens <= tokenBudget) {
          parts.push(`# ${f.replace(".md", "")}\n${content}`);
          tokenBudget -= tokens;
        } else {
          const maxChars = tokenBudget * 4;
          parts.push(
            `# ${f.replace(".md", "")} (truncated)\n...${content.slice(-maxChars)}`,
          );
          break;
        }
      } catch {
        continue;
      }
    }

    if (parts.length <= 1) return null;
    return parts.join("\n\n");
  }

  async remember(fact: string): Promise<void> {
    await this.writeFact("decisions", fact);
  }
}
