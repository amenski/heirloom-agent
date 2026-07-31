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

// The scripted "happy path" provider used by the permission tests: one tool call
// on turn 1, then finishes on turn 2. Individual tests can swap `providerFactory`
// to make createProvider throw (B1) or stream an error (B6).
function scriptedProvider() {
  return {
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
  };
}

// createProvider is captured (so B2 can assert the config baseUrl reaches it) and
// delegates to a swappable factory (so B1/B6 can script failures).
const createProviderSpy = vi.fn();
let providerFactory: (name: string, options?: unknown) => unknown = () => scriptedProvider();

vi.mock("./providers/presets.js", () => ({
  initPresets: () => {},
  getPreset: () => undefined,
  createProvider: (name: string, options?: unknown) => {
    createProviderSpy(name, options);
    return providerFactory(name, options);
  },
}));

vi.mock("./tools/index.js", () => ({
  executeTool: (call: ToolCall) => executeToolSpy(call),
  registry: { getAllDefs: () => [] },
  setSessionId: () => {},
  setSignal: () => {},
}));

// The notify hook is mocked so the completion-site tests below can assert
// whether/how it fires without spawning a real script.
const fireNotifySpy = vi.fn();
vi.mock("./notify.js", () => ({
  fireNotify: (...args: unknown[]) => fireNotifySpy(...args),
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

async function run(opts?: { mode?: string; debug?: boolean }): Promise<{ code: number; stderr: string }> {
  const { runExecMode } = await import("./exec-runner.js");
  const chunks: string[] = [];
  // console.error routes through process.stderr.write, so spying on write
  // captures both the exec-runner's own lines and any leaked SDK dumps.
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    chunks.push(String(chunk));
    return true;
  });
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const code = await runExecMode({
      prompt: "go",
      projectRoot: PROJECT_DIR,
      input: nonTtyInput(),
      mode: opts?.mode,
      debug: opts?.debug,
    });
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
    createProviderSpy.mockClear();
    providerFactory = () => scriptedProvider();
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

// B1 — a brand-new user's first command must never surface a raw Node stack
// trace. Every failure reachable before the agent runs (missing key, unknown
// provider, unknown mode) must be one/two clean stderr lines with exit code 1.
describe("runExecMode first-run failures are clean (B1)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.DEEPCODE_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.DEEPCODE_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("missing provider key exits 1 with a clean one-line message pointing to auth", async () => {
    writeSettings({ provider: "deepseek" });
    providerFactory = () => {
      throw new Error(
        'Provider "deepseek" requires DEEPSEEK_API_KEY to be set, or run `heirloom auth` to store a key in credentials.yaml',
      );
    };

    const { code, stderr } = await run();

    expect(code).toBe(1);
    const lines = stderr.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("heirloom auth");
    expect(stderr).not.toContain("    at "); // no stack frames
  });

  it("unknown provider exits 1 with a clean message", async () => {
    writeSettings({ provider: "nope" });
    providerFactory = () => {
      throw new Error('Unknown provider: "nope". Known: deepseek, openai');
    };

    const { code, stderr } = await run();

    expect(code).toBe(1);
    expect(stderr).toContain('Error: Unknown provider: "nope"');
    expect(stderr).not.toContain("    at ");
  });

  it("unknown --mode exits 1 with an 'unknown mode' message listing available modes", async () => {
    writeSettings({ provider: "deepseek" });

    const { code, stderr } = await run({ mode: "bogusmode" });

    expect(code).toBe(1);
    expect(stderr).toContain('unknown mode "bogusmode"');
    expect(stderr).toContain("available:");
    expect(stderr).toContain("code"); // a real built-in mode
    expect(stderr).not.toContain("    at ");
    // The provider gate must not have fired — mode is validated first.
    expect(createProviderSpy).not.toHaveBeenCalled();
  });
});

// B6 — provider/API failures during the run must print one concise line
// (status + provider message), not the entire AI SDK error object. The full
// dump (the SDK's default console.error(error)) is only allowed with --debug.
describe("runExecMode provider failures are concise (B6)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.DEEPCODE_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
    writeSettings({ provider: "deepseek" });
  });

  afterEach(() => {
    delete process.env.DEEPCODE_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("extracts status + message from an APICallError and suppresses the object dump", async () => {
    const { APICallError } = await import("ai");
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        // Simulate the AI SDK's default onError, which dumps the whole object.
        console.error(
          new APICallError({
            message: "Authentication Fails",
            url: "https://api.deepseek.com/chat/completions",
            requestBodyValues: { model: "deepseek-v4-pro", secret: "leaked" },
            statusCode: 401,
            responseHeaders: { "x-request-id": "abc" },
            responseBody: '{"error":"Authentication Fails"}',
            isRetryable: false,
          }),
        );
        throw new APICallError({
          message: "Authentication Fails",
          url: "https://api.deepseek.com/chat/completions",
          requestBodyValues: { model: "deepseek-v4-pro", secret: "leaked" },
          statusCode: 401,
          responseHeaders: { "x-request-id": "abc" },
          responseBody: '{"error":"Authentication Fails"}',
          isRetryable: false,
        });
        yield { type: "done", finishReason: "stop" };
      },
    });

    const { code, stderr } = await run();

    expect(code).toBe(1);
    expect(stderr).toContain("Error: HTTP 401: Authentication Fails");
    // None of the internal request detail leaks without --debug.
    expect(stderr).not.toContain("requestBodyValues");
    expect(stderr).not.toContain("leaked");
    expect(stderr).not.toContain("x-request-id");
  });

  it("unwraps a RetryError to the last provider error", async () => {
    const { APICallError, RetryError } = await import("ai");
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        const api = new APICallError({
          message: "Cannot connect to API: bad port",
          url: "http://127.0.0.1:9/chat/completions",
          requestBodyValues: {},
          isRetryable: true,
        });
        throw new RetryError({
          message: "Failed after 4 attempts. Last error: AI_APICallError: Cannot connect to API: bad port",
          reason: "maxRetriesExceeded",
          errors: [api],
        });
        yield { type: "done", finishReason: "stop" };
      },
    });

    const { code, stderr } = await run();

    expect(code).toBe(1);
    expect(stderr).toContain("Error: Cannot connect to API: bad port");
    expect(stderr).not.toContain("Failed after 4 attempts");
  });

  it("with --debug, the full error object is handed to console.error for diagnosis", async () => {
    const { APICallError } = await import("ai");
    const thrown = new APICallError({
      message: "Authentication Fails",
      url: "https://api.deepseek.com/chat/completions",
      requestBodyValues: { model: "deepseek-v4-pro" },
      statusCode: 401,
      responseHeaders: {},
      responseBody: "{}",
      isRetryable: false,
    });
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        throw thrown;
        yield { type: "done", finishReason: "stop" };
      },
    });
    // With --debug, exec-runner leaves console.error live and re-emits the full
    // error object through it. Spy so we can assert the object (not a string) is
    // passed for the developer to inspect.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { code, stderr } = await run({ debug: true });

    expect(code).toBe(1);
    expect(stderr).toContain("Error: HTTP 401: Authentication Fails");
    expect(errSpy).toHaveBeenCalledWith(thrown);
    errSpy.mockRestore();
  });

  it("without --debug, console.error is suppressed so the SDK object dump cannot leak", async () => {
    const { APICallError } = await import("ai");
    // A live spy on console.error stands in for the SDK's default onError dump.
    const errSpy = vi.spyOn(console, "error");
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        // The SDK would dump the whole object here; exec-runner must have
        // replaced console.error with a no-op, so this reaches nothing.
        console.error("FULL_SDK_DUMP requestBodyValues secret");
        throw new APICallError({
          message: "Authentication Fails",
          url: "https://api.deepseek.com/chat/completions",
          requestBodyValues: {},
          statusCode: 401,
          responseHeaders: {},
          responseBody: "{}",
          isRetryable: false,
        });
        yield { type: "done", finishReason: "stop" };
      },
    });

    const { code, stderr } = await run();

    expect(code).toBe(1);
    expect(stderr).toContain("Error: HTTP 401: Authentication Fails");
    expect(stderr).not.toContain("FULL_SDK_DUMP");
    errSpy.mockRestore();
  });
});

// B2 — settings.json env.BASE_URL (and API_KEY) must actually reach the
// built-in provider path. We assert createProvider receives the config values.
describe("runExecMode honors config BASE_URL / API_KEY (B2)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.DEEPCODE_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.DEEPCODE_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("passes env.BASE_URL and env.API_KEY from settings.json into createProvider", async () => {
    writeSettings({
      provider: "deepseek",
      env: { BASE_URL: "http://127.0.0.1:9", API_KEY: "sk-from-config" },
    });

    const { code } = await run();

    expect(code).toBe(0);
    expect(createProviderSpy).toHaveBeenCalledWith(
      "deepseek",
      expect.objectContaining({ baseUrl: "http://127.0.0.1:9", apiKey: "sk-from-config" }),
    );
  });
});

// Notify hook fires from the headless completion boundary — once on a normal
// end ("completed"), once with FAIL_REASON on a provider failure ("failed"),
// and never when `notify` is absent from settings.json.
describe("runExecMode fires the notify hook at the completion boundary", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.DEEPCODE_HOME = HOME_DIR;
    createProviderSpy.mockClear();
    fireNotifySpy.mockClear();
    providerFactory = () => scriptedProvider();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.DEEPCODE_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("passes an undefined script path when `notify` is absent (fireNotify no-ops on it)", async () => {
    writeSettings({ provider: "deepseek" });

    const { code } = await run();

    expect(code).toBe(0);
    // The completion site always calls fireNotify; the no-op-when-unconfigured
    // guard lives inside fireNotify (covered in notify.test.ts). Here we assert
    // the site forwards `undefined` when `notify` is not set.
    expect(fireNotifySpy).toHaveBeenCalledTimes(1);
    expect(fireNotifySpy.mock.calls[0][0]).toBeUndefined();
  });

  it("fires with status 'completed', the config script path, last reply body, and passthrough env", async () => {
    writeSettings({
      provider: "deepseek",
      notify: "/tmp/notify.sh",
      env: { SLACK_WEBHOOK_URL: "https://hooks.example/x" },
    });

    const { code } = await run();

    expect(code).toBe(0);
    expect(fireNotifySpy).toHaveBeenCalledTimes(1);
    const [scriptPath, input] = fireNotifySpy.mock.calls[0] as [string, any];
    expect(scriptPath).toBe("/tmp/notify.sh");
    expect(input.status).toBe("completed");
    expect(input.body).toBe("done"); // the scripted provider's last reply text
    expect(input.title).toBe("go"); // first-prompt prefix
    expect(input.passthroughEnv).toMatchObject({ SLACK_WEBHOOK_URL: "https://hooks.example/x" });
  });

  it("fires with status 'failed' and a FAIL_REASON when the provider throws", async () => {
    writeSettings({ provider: "deepseek", notify: "/tmp/notify.sh" });
    providerFactory = () => ({
      name: "fake",
      // eslint-disable-next-line require-yield
      async *streamChat(): AsyncGenerator<StreamEvent> {
        throw new Error("stream exploded");
      },
    });

    const { code } = await run();

    expect(code).toBe(1);
    expect(fireNotifySpy).toHaveBeenCalledTimes(1);
    const [scriptPath, input] = fireNotifySpy.mock.calls[0] as [string, any];
    expect(scriptPath).toBe("/tmp/notify.sh");
    expect(input.status).toBe("failed");
    expect(input.failReason).toContain("stream exploded");
  });
});

// Proves the self-reflection / error-recovery subsystems are actually
// constructed and passed by the headless call site — before wiring they were
// always undefined, so neither of these behaviors could occur.
describe("runExecMode wires self-reflection + error-recovery (engagement)", () => {
  beforeEach(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    mkdirSync(HOME_DIR, { recursive: true });
    process.env.DEEPCODE_HOME = HOME_DIR;
    executeToolSpy.mockClear();
    createProviderSpy.mockClear();
    scriptedCall = null;
  });

  afterEach(() => {
    delete process.env.DEEPCODE_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("errorReflector: a failing tool result drives a reflection retry turn", async () => {
    // allowAll so the tool runs; it returns an error the first time. The wired
    // reflector injects a retry prompt, so the provider is asked for a second
    // turn (which finishes). Without a reflector the run would stop after the
    // single failed turn without re-prompting.
    writeSettings({ provider: "deepseek", permissions: { defaultMode: "allowAll", rules: [] } });

    let providerTurns = 0;
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        providerTurns++;
        if (providerTurns === 1) {
          yield { type: "tool_call_start", id: "c1", name: "read_file" };
          yield { type: "tool_call_delta", id: "c1", arguments: JSON.stringify({ path: "a.txt" }) };
          yield { type: "done", finishReason: "tool_calls" };
        } else {
          yield { type: "text_delta", content: "recovered" };
          yield { type: "done", finishReason: "stop" };
        }
      },
    });
    executeToolSpy.mockImplementationOnce(async () => ({ content: "", error: "ENOENT: missing" }));

    const { code } = await run();

    expect(code).toBe(0);
    // A second provider turn only happens because the reflector re-prompted
    // after the failed tool result.
    expect(providerTurns).toBe(2);
  });

  it("errorRecovery: malformed tool-call JSON drives a correction retry instead of executing the tool", async () => {
    writeSettings({ provider: "deepseek", permissions: { defaultMode: "allowAll", rules: [] } });

    let providerTurns = 0;
    providerFactory = () => ({
      name: "fake",
      async *streamChat(): AsyncGenerator<StreamEvent> {
        providerTurns++;
        if (providerTurns === 1) {
          yield { type: "tool_call_start", id: "c1", name: "read_file" };
          yield { type: "tool_call_delta", id: "c1", arguments: "{not json" };
          yield { type: "done", finishReason: "tool_calls" };
        } else {
          yield { type: "text_delta", content: "fixed" };
          yield { type: "done", finishReason: "stop" };
        }
      },
    });

    const { code } = await run();

    expect(code).toBe(0);
    // The malformed call is never executed; recovery re-prompts for valid JSON.
    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(providerTurns).toBe(2);
  });
});
