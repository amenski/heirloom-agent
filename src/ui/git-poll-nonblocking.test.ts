import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "App.tsx"),
  "utf-8",
);

/**
 * Regression guard for the recurring "Working…" freeze.
 *
 * The git-status poll runs on a setInterval (default 30s). It originally used
 * execSync, which blocks the main thread for as long as git takes — measured at
 * 100-670ms across real repos, scaling with worktree size, and the
 * `@{upstream}` rev-list can even touch the network. That stalls the spinner
 * AND the elapsed clock together (the main-thread-block signature) on a fixed
 * cadence, regardless of whether a turn is running.
 *
 * These assert on source text rather than behavior because the cost only shows
 * up with a real child process, which a unit test should not spawn. The point
 * is to make a reintroduction of execSync here fail loudly.
 */
describe("git status poll stays off the main thread", () => {
  it("does not use execSync anywhere in App.tsx", () => {
    // Comments explaining the fix legitimately mention execSync; strip them
    // first so only real call sites can fail this.
    const withoutComments = appSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(withoutComments).not.toMatch(/\bexecSync\b/);
  });

  it("imports the async exec and promisifies it", () => {
    expect(appSource).toMatch(/import\(["']node:child_process["']\)/);
    expect(appSource).toMatch(/promisify/);
  });

  it("runs the two independent git reads concurrently", () => {
    // status and rev-list do not depend on each other; serial awaits would
    // double the latency for no reason.
    expect(appSource).toMatch(/Promise\.all\(\[[\s\S]*?git status --porcelain/);
  });

  it("still bails out when the branch lookup yields nothing", () => {
    // Non-git directories must clear the status rather than render a partial
    // one — this was the pre-existing behavior and must survive the rewrite.
    expect(appSource).toMatch(/if \(!branch \|\| cancelled\)/);
  });
});
