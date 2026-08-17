import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * The returned command MUST stay a hardcoded literal. package.json comes from
 * the working directory — a cloned repo is untrusted input — and the result
 * goes to runLinter, which runs it through a shell. Reading the command from
 * the file (`pkg.scripts.lint`, a `lintCommand` field, …) would turn cloning a
 * repo into arbitrary code execution, which is exactly the shape that made
 * `search` injectable before 16ddaaf. The file may decide only WHETHER a
 * linter runs, never WHAT runs.
 */
function detectLinter(workingDir: string): string | null {
  const pkgPath = join(workingDir, "package.json");
  if (!existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.devDependencies?.typescript) {
      return "npx tsc --noEmit";
    }
  } catch {
    return null;
  }
  return null;
}

/** Shell execution — safe only because `cmd` is a literal from detectLinter. */
async function runLinter(cmd: string, cwd: string): Promise<string> {
  try {
    await execAsync(cmd, { cwd, encoding: "utf-8", timeout: 30000 });
    return "";
  } catch (err: any) {
    if (err.killed) return "";
    return (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
  }
}

function diffNewErrors(before: string, after: string): string[] {
  const beforeSet = new Set(
    before.split("\n").map((l) => l.trim()).filter(Boolean),
  );
  return after
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => Boolean(l) && !beforeSet.has(l));
}

export class DiagnosticRunner {
  private linter: string | null;
  private workingDir: string;
  private baseline: string = "";

  constructor(workingDir?: string) {
    this.workingDir = workingDir ?? process.cwd();
    this.linter = detectLinter(this.workingDir);
  }

  get available(): boolean {
    return this.linter !== null;
  }

  async snapshot(): Promise<void> {
    if (!this.linter) return;
    this.baseline = await runLinter(this.linter, this.workingDir);
  }

  async check(): Promise<string | null> {
    if (!this.linter) return null;

    await new Promise((r) => setTimeout(r, 500));

    const current = await runLinter(this.linter, this.workingDir);

    if (!this.baseline || current === this.baseline) return null;

    const errors = diffNewErrors(this.baseline, current);
    if (errors.length === 0) return null;

    this.baseline = current;
    return errors.join("\n");
  }
}
