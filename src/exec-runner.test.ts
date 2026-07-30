import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StreamEvent } from "./providers/types.js";
import type { ToolCall, ToolOutput } from "./types.js";
import type { ExecInputStream } from "./exec-input.js";

// Verifies that headless exec mode (`-x`) runs WITH the permission engine and
// fails closed (T11). We mock the two boundaries `runExecMode` reaches out to:
//   - ./providers/presets.js — so no network call is made; the fake provider
//     scripts exactly one tool call on turn 1, then finishes on turn 2.
//   - ./tools/index.js — so we can spy on whether executeTool actually ran, and
//     avoid touching the real tool registry.
// The permission engine itself is NOT mocked: we drive real rule resolution
// (allow rule, defaultMode ask, guarded tier, destructive deny) through the
// real runAgent code path that exec-runner wires up.

const TEST_DIR = join(tmpdir(), `heirloom-exec-runner-${process.pid}`);
const HOME_DIR = join(TEST_DIR, "home");
const PROJECT_DIR = join(TEST_DIR, "project");

let scriptedCall: { name: string; args: Record<string, unknown> } | null = null;
const executeToolSpy = vi.fn(async (_call: ToolCall): Promise<ToolOutput> => ({ content: "ok" }));

vi.mock("./providers/presets.js", () => ({
  initPresets: () => {},
  getPreset: () => undefined,
  createProvider: () => ({
    name: "fake",
    async *streamChat(): AsyncGenerator<StreamEvent> {
      if (scriptedCall) {
        const call = scriptedCall;
        scriptedCall = null;
        yield { type: "tool_call_start", id: "call-1", name: call.name };
        yield { type: "tool_call_delta", id: "call-1", arguments: JSON.stringify(call.args) };
        yield { type: "done", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", content: "done" };
        yield { type: "done", finishReason: "stop" };
      }
    },
  }),
}));

vi.mock("./tools/index.js", () => ({
  executeTool: (call: ToolCall) => executeToolSpy(call),
  registry: { getAllDefs: () => [] },
  setSessionId: () => {},
  setSignal: () => {},
}));

function nonTtyInput(): ExecInputStream {
  // isTTY:false with an empty stream => buildExecPrompt returns the prompt as-is.
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      /* empty stdin */
    },
  };
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(PROJECT_DIR, ".deepcode"), { recursive: true });
  writeFileSync(join(PROJECT_DIR, ".deepcode", "settings.json"), JSON.stringify(settings), "utf-8");
}

async function run(): Promise<{ code: number; stderr: string }> {
  const { runExecMode } = await import("./exec-runner.js");
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    chunks.push(String(chunk));
    return true;
  });
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const code = await runExecMode({ prompt: "go", projectRoot: PROJECT_DIR, input: nonTtyInput() });
    return { code, stderr: chunks.join("") };
  } finally {
    writeSpy.mockRestore();
    outSpy.mockRestore();
  }
}

describe("runExecMode headless permission enforcement (T11)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    // Isolate from the developer's real ~/.deepcode/settings.json.
    process.env.DEEPCODE_HOME = HOME_DIR;
    executeToolSpy.mockClear();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.DEEPCODE_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("(a) executes a tool call that matches an explicit allow rule", async () => {
    writeSettings({ permissions: { rules: [{ tool: "run_bash", pattern: "git status", action: "allow" }] } });
    scriptedCall = { name: "run_bash", args: { command: "git status" } };

    const { stderr } = await run();

    expect(executeToolSpy).toHaveBeenCalledTimes(1);
    expect(stderr).not.toContain("permission denied (headless)");
  });

  it("(b) denies an ask-resolving call (defaultMode askAll) without executing it", async () => {
    writeSettings({ permissions: { defaultMode: "askAll", rules: [] } });
    scriptedCall = { name: "run_bash", args: { command: "echo hi" } };

    const { stderr } = await run();

    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(stderr).toContain("permission denied (headless): run_bash echo hi");
  });

  it("(c) denies a guarded-tier call (reading .env) without executing it", async () => {
    writeSettings({ permissions: { defaultMode: "allowAll", rules: [] } });
    scriptedCall = { name: "read_file", args: { path: join(PROJECT_DIR, ".env") } };

    const { stderr } = await run();

    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(stderr).toContain("permission denied (headless): read_file");
  });

  it("(d) denies a destructive-tier call (rm -rf /) without executing it", async () => {
    writeSettings({ permissions: { defaultMode: "allowAll", rules: [] } });
    scriptedCall = { name: "run_bash", args: { command: "rm -rf /" } };

    const { stderr } = await run();

    expect(executeToolSpy).not.toHaveBeenCalled();
    // Destructive deny never reaches askUser, so no headless-ask notice — but
    // the call must still be blocked from executing.
    expect(stderr).not.toContain("permission denied (headless): run_bash rm -rf /");
  });

  it("(e) the deny path emits a single stderr notice naming the tool and subject", async () => {
    writeSettings({ permissions: { defaultMode: "askAll", rules: [] } });
    scriptedCall = { name: "run_bash", args: { command: "npm install left-pad" } };

    const { stderr } = await run();

    const notices = stderr.split("\n").filter((l) => l.includes("permission denied (headless)"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe("permission denied (headless): run_bash npm install left-pad");
  });
});
