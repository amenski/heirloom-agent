import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

let TEST_HOME = "";

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => TEST_HOME,
  };
});

describe("checkpoint secret handling", () => {
  let workspaceDir: string;

  async function chkptManager(): Promise<import("./index.js").CheckpointManager> {
    const mod = await import("./index.js");
    return new mod.CheckpointManager("test-session", workspaceDir);
  }

  function shadowGitDir(): string {
    return join(TEST_HOME, ".heirloom", "checkpoints", "test-session", ".git");
  }

  beforeEach(async () => {
    TEST_HOME = mkdtempSync(join(tmpdir(), "heirloom-chkpt-home-"));

    workspaceDir = mkdtempSync(join(tmpdir(), "heirloom-chkpt-workspace-"));

    execSync("git init", { cwd: workspaceDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: workspaceDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: workspaceDir, stdio: "pipe" });

    writeFileSync(join(workspaceDir, ".gitignore"), ".env\nnode_modules/\n");
    writeFileSync(join(workspaceDir, ".env"), 'API_KEY="sk-test-secret-key"\n');
    writeFileSync(join(workspaceDir, "app.ts"), "console.log('hello');\n");

    execSync("git add .gitignore && git commit -m init", { cwd: workspaceDir, stdio: "pipe" });
    execSync("git add app.ts && git commit -m 'add app'", { cwd: workspaceDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("does not include gitignored .env in checkpoint shadow repo", async () => {
    const mgr = await chkptManager();

    const hash = await mgr.save("pre-modify");
    expect(hash).toBeTruthy();

    const tracked = execSync(
      `git --git-dir="${shadowGitDir()}" ls-files`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    const files = tracked.split("\n").filter(Boolean);

    expect(files).toContain(".gitignore");
    expect(files).toContain("app.ts");

    const envFiles = files.filter((f) => f === ".env" || f.includes(".env"));
    expect(envFiles).toHaveLength(0);
  });

  it("restore does not recreate gitignored .env that was never tracked", async () => {
    const mgr = await chkptManager();

    await mgr.save("pre-delete");

    expect(existsSync(join(workspaceDir, "app.ts"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".env"))).toBe(true);

    rmSync(join(workspaceDir, "app.ts"));
    rmSync(join(workspaceDir, ".env"));

    const result = await mgr.restore("files");
    expect(result.restored).toBe(true);

    expect(existsSync(join(workspaceDir, "app.ts"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".env"))).toBe(false);
  });
});
