import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

function runLinter(cmd: string, cwd: string): string {
  try {
    execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8", timeout: 30000 });
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

  snapshot(): void {
    if (!this.linter) return;
    this.baseline = runLinter(this.linter, this.workingDir);
  }

  async check(): Promise<string | null> {
    if (!this.linter) return null;

    await new Promise((r) => setTimeout(r, 500));

    const current = runLinter(this.linter, this.workingDir);

    if (!this.baseline || current === this.baseline) return null;

    const errors = diffNewErrors(this.baseline, current);
    if (errors.length === 0) return null;

    this.baseline = current;
    return errors.join("\n");
  }
}
