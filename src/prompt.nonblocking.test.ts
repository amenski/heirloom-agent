import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const promptSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.ts"),
  "utf-8",
);

/**
 * Regression guard for the recurring "Working…" freeze.
 *
 * The per-turn environment block ran two execSync git calls (branch +
 * porcelain status), blocking the main thread for as long as git takes —
 * multi-second freezes on a loaded machine, the same disease the git-status
 * poll and checkpoint manager already cured. The volatile context is rebuilt
 * every turn, so this organ was the per-turn hit, not a 30s poll.
 *
 * These assert on source text rather than behavior because the cost only shows
 * up with a real child process, which a unit test should not spawn. The point
 * is to make a reintroduction of execSync here fail loudly.
 */
describe("prompt environment stays off the main thread", () => {
  it("does not use execSync anywhere in prompt.ts", () => {
    // Comments explaining the fix legitimately mention execSync; strip them
    // first so only real call sites can fail this.
    const withoutComments = promptSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(withoutComments).not.toMatch(/\bexecSync\b/);
  });

  it("runs git through execFile with an args array, never a shell string", () => {
    expect(promptSource).toMatch(/\bexecFile\b/);
    expect(promptSource).toMatch(/execFileAsync|run\(["']git["'],/);
    expect(promptSource).not.toMatch(/execFile\(\s*`/);
  });

  it("runs the two independent git reads concurrently", () => {
    // branch and status do not depend on each other; serial awaits would
    // double the latency for no reason.
    expect(promptSource).toMatch(/Promise\.all\(\[/);
  });

  it("still bails out when the branch lookup yields nothing", () => {
    // Non-git directories must fall back to "not a git repository" rather
    // than render a partial one — this was the pre-existing behavior and
    // must survive the rewrite.
    expect(promptSource).toMatch(/not a git repository/);
  });
});
