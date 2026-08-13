import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HookRunner, hookPairHash } from "./index.js";
import { parseHooksConfig } from "./config.js";
import type { HooksConfig } from "./types.js";

// TOFU trust model (hooks-spec.md §6): global (~/.heirloom) hooks are trusted
// implicitly; project hooks must clear hooks-trust.json, prompting exactly
// once per unseen pair (y = trust forever, n = skip this session). Headless
// runs skip untrusted hooks with a stderr warning.

const TEST_DIR = join(tmpdir(), `heirloom-hooks-trust-${process.pid}`);
const HOME_DIR = join(TEST_DIR, "home");
const TRUST_FILE = join(HOME_DIR, "hooks-trust.json");

function projectConfig(hooks: Record<string, unknown>): HooksConfig {
  const parsed = parseHooksConfig(undefined, hooks, "test", []);
  if (!parsed) throw new Error("parseHooksConfig returned undefined");
  return parsed;
}

function globalConfig(hooks: Record<string, unknown>): HooksConfig {
  const parsed = parseHooksConfig(hooks, undefined, "test", []);
  if (!parsed) throw new Error("parseHooksConfig returned undefined");
  return parsed;
}

function makeRunner(
  config: HooksConfig,
  overrides?: Partial<ConstructorParameters<typeof HookRunner>[0]>,
): HookRunner {
  return new HookRunner({
    config,
    cwd: TEST_DIR,
    sessionId: () => "s1",
    getPermissionMode: () => "normal",
    timeoutMs: 2000,
    ...overrides,
  });
}

const markerFile = join(TEST_DIR, "ran");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });
  process.env.HEIRLOOM_HOME = HOME_DIR;
});

afterEach(() => {
  delete process.env.HEIRLOOM_HOME;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("TOFU trust", () => {
  it("trusts global hooks implicitly — never prompts", async () => {
    const runner = makeRunner(globalConfig({
      PreToolUse: [{ command: `touch '${markerFile}'` }],
    }));
    const confirmTrust = vi.fn(async () => true);
    runner.confirmTrust = confirmTrust;

    const result = await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(confirmTrust).not.toHaveBeenCalled();
    expect(result.blocked).toBe(false);
    expect(existsSync(markerFile)).toBe(true);
  });

  it("prompts exactly once per unseen project hook, then runs it", async () => {
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: `touch '${markerFile}'` }],
    }));
    const confirmTrust = vi.fn(async () => true);
    runner.confirmTrust = confirmTrust;

    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(confirmTrust).toHaveBeenCalledTimes(1);
    expect(confirmTrust).toHaveBeenCalledWith(expect.objectContaining({
      event: "PreToolUse",
      command: `touch '${markerFile}'`,
      origin: "project",
    }));
    expect(existsSync(markerFile)).toBe(true);
  });

  it("persists the trust forever when the user says yes", async () => {
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: `touch '${markerFile}'` }],
    }));
    runner.confirmTrust = async () => true;
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(existsSync(TRUST_FILE)).toBe(true);

    // A brand-new runner (next session, same HOME) must not prompt again.
    const confirmTrust = vi.fn(async () => true);
    const second = makeRunner(projectConfig({
      PreToolUse: [{ command: `touch '${markerFile}'` }],
    }));
    second.confirmTrust = confirmTrust;
    await second.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(confirmTrust).not.toHaveBeenCalled();
  });

  it("a 'no' skips the hook for the rest of the session without re-prompting", async () => {
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: `touch '${markerFile}'` }],
    }));
    const confirmTrust = vi.fn(async () => false);
    runner.confirmTrust = confirmTrust;

    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

    expect(confirmTrust).toHaveBeenCalledTimes(1);
    expect(existsSync(markerFile)).toBe(false);
  });

  it("headless skips untrusted project hooks with a stderr warning and never prompts", async () => {
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: `touch '${markerFile}'` }],
    }), { headless: true });
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      runner.verifyTrust();

      const result = await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

      expect(result.blocked).toBe(false);
      expect(existsSync(markerFile)).toBe(false);
      expect(stderr.join("")).toContain("skipping untrusted project hook");
      expect(stderr.join("")).toContain("PreToolUse");
    } finally {
      spy.mockRestore();
    }
  });

  it("headless runs trusted project hooks without prompting", async () => {
    // Pre-trust the pair (as a previous interactive session would have).
    const runner = makeRunner(projectConfig({
      PreToolUse: [{ command: `touch '${markerFile}'` }],
    }));
    runner.confirmTrust = async () => true;
    await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} }); // interactive ask, persists
    expect(existsSync(TRUST_FILE)).toBe(true);

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const headless = makeRunner(projectConfig({
        PreToolUse: [{ command: `touch '${markerFile}'` }],
      }), { headless: true });
      headless.verifyTrust();
      await headless.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

      expect(stderr).not.toHaveBeenCalled();
      expect(existsSync(markerFile)).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("disableAllHooks overrides everything — no prompts, no warnings, nothing runs", async () => {
    const runner = makeRunner(
      projectConfig({ PreToolUse: [{ command: `touch '${markerFile}'` }] }),
      { headless: true, disableAllHooks: true },
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      runner.verifyTrust();
      await runner.dispatch("PreToolUse", { tool_name: "run_bash", tool_input: {} });

      expect(stderr).not.toHaveBeenCalled();
      expect(existsSync(markerFile)).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });

  it("hashes event|command pairs deterministically", () => {
    expect(hookPairHash("PreToolUse", "guard.sh")).toBe(hookPairHash("PreToolUse", "guard.sh"));
    expect(hookPairHash("PreToolUse", "guard.sh")).not.toBe(hookPairHash("PostToolUse", "guard.sh"));
    expect(hookPairHash("PreToolUse", "guard.sh")).not.toBe(hookPairHash("PreToolUse", "other.sh"));
  });
});
