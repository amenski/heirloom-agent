import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBash, runBashTimed, resolveTimeoutToBackground } from "./bash.js";
import { jobManager } from "./jobs.js";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./types.js";
import { basename } from "node:path";

const onDarwin = process.platform === "darwin";
const itOnDarwin = it.skipIf(!onDarwin);

const mockCtx: ToolContext = {
  workingDir: process.cwd(),
  sessionId: "test",
  signal: new AbortController().signal,
};

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("runBashTimed (plan §3 timeout→background migration)", () => {
  beforeEach(() => {
    jobManager.cleanup();
  });

  afterEach(() => {
    jobManager.killAll();
  });

  it("returns stdout on success and Exit code on failure", async () => {
    const ok = await runBashTimed("echo bash-migration-test", process.cwd(), process.cwd(), 5000, true);
    expect(ok.content).toContain("bash-migration-test");

    const fail = await runBashTimed("exit 3", process.cwd(), process.cwd(), 5000, true);
    expect(fail.content).toContain("Exit code: 3");
  });

  it("migrates a timed-out command to the background and preserves output continuity", async () => {
    const result = await runBashTimed("echo before; sleep 1; echo after", process.cwd(), process.cwd(), 250, true);
    expect(result.content).toContain("moved to background");
    const match = result.content.match(/job ([0-9a-f-]{36})/);
    expect(match).not.toBeNull();
    const jobId = match![1];

    // Pre-migration output (seeded into the job) and post-adoption output
    // (streamed after the handover) both appear in check_job.
    await waitFor(() => {
      const report = jobManager.check(jobId);
      return report !== null && report.status !== "running" && report.stdout.includes("after");
    });
    const report = jobManager.check(jobId)!;
    expect(report.status).toBe("done");
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain("before");
    expect(report.stdout).toContain("after");
  });

  it("kills interactive-looking commands on timeout even with the config ON", async () => {
    const result = await runBashTimed("sleep 30", process.cwd(), process.cwd(), 250, true);
    expect(result.content).toContain("Exit code: null");
    expect(result.content).not.toContain("moved to background");
    // Nothing was migrated: the sleep command never became a job.
    expect(jobManager.list().filter((j) => j.command === "sleep 30")).toHaveLength(0);
  });

  it("kills on timeout when the config is OFF", async () => {
    const result = await runBashTimed("sleep 30", process.cwd(), process.cwd(), 250, false);
    expect(result.content).toContain("Exit code: null");
    expect(result.content).not.toContain("moved to background");
    expect(jobManager.list().filter((j) => j.command === "sleep 30")).toHaveLength(0);
  });

  it("truncates output beyond 512KB with a note instead of killing", async () => {
    const result = await runBashTimed("yes x | head -c 600000", process.cwd(), process.cwd(), 5000, true);
    expect(result.content).toContain("(output truncated — kept last 512KB)");
    expect(result.content).not.toContain("moved to background");
  });

  it("resolveTimeoutToBackground defaults ON (decision D)", () => {
    expect(resolveTimeoutToBackground(undefined)).toBe(true);
    expect(resolveTimeoutToBackground(true)).toBe(true);
    expect(resolveTimeoutToBackground(false)).toBe(false);
  });
});

describe("run_bash handler trusted-root cwd handling (item 8.6)", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerBash(registry);
  });

  it("cwd omitted defaults to ctx.workingDir (the trusted root)", async () => {
    const out = await registry.execute(
      { id: "1", name: "run_bash", arguments: { command: "pwd" } },
      mockCtx,
    );
    expect(out.error).toBeUndefined();
    expect(out.content).toContain(basename(process.cwd()));
  });

  it("no sandbox level → a cwd outside the workspace is unchanged behavior", async () => {
    const out = await registry.execute(
      { id: "1", name: "run_bash", arguments: { command: "pwd", cwd: "/tmp" } },
      mockCtx,
    );
    expect(out.error).toBeUndefined();
    expect(out.content).toContain("tmp");
  });

  itOnDarwin("sandboxed: rejects a cwd outside the trusted root with a tool error", async () => {
    const out = await registry.execute(
      { id: "1", name: "run_bash", arguments: { command: "echo hi", cwd: "/tmp" } },
      { ...mockCtx, sandboxLevel: "workspace-write" },
    );
    expect(out.content).toBe("");
    expect(out.error).toContain("Working directory escapes the sandbox workspace root");
  });
});
