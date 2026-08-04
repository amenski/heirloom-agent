import { describe, it, expect, vi } from "vitest";
import { runAgent } from "./agent.js";
import { PermissionEngine } from "./permissions/index.js";
import { ErrorReflector } from "./selfreflection/index.js";
import { ErrorRecovery } from "./errorrecovery/index.js";
import type { Provider, StreamEvent } from "./providers/types.js";
import type { Message } from "./types.js";

vi.mock("./prompt.js", () => ({
  buildStablePreamble: vi.fn(() => "SYSTEM PROMPT"),
  buildVolatileContext: vi.fn(async () => ""),
}));

type TurnScript = StreamEvent[];

function makeProvider(turns: TurnScript[]) {
  const receivedMessages: Message[][] = [];
  let call = 0;
  const provider: Provider = {
    name: "fake",
    async *streamChat(messages) {
      receivedMessages.push([...messages]);
      const events = turns[call] ?? [];
      call++;
      for (const event of events) yield event;
    },
  };
  return { provider, receivedMessages };
}

const textTurn = (text: string): TurnScript => [
  { type: "text_delta", content: text },
  { type: "done", finishReason: "stop" },
];

describe("runAgent", () => {
  it("keeps a text-only assistant reply in messages and newMessages", async () => {
    const { provider } = makeProvider([textTurn("Hello there")]);

    const result = await runAgent("hi", {
      provider,
      tools: [],
      executeTool: async () => ({ content: "" }),
    });

    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "Hello there" });
    expect(result.newMessages).toEqual([{ role: "assistant", content: "Hello there" }]);
  });

  it("sends a single system prompt at position 0 across turns", async () => {
    const first = makeProvider([textTurn("first reply")]);
    const firstResult = await runAgent("hi", {
      provider: first.provider,
      tools: [],
      executeTool: async () => ({ content: "" }),
    });

    const second = makeProvider([textTurn("second reply")]);
    await runAgent("who are you?", {
      provider: second.provider,
      tools: [],
      executeTool: async () => ({ content: "" }),
      history: firstResult.messages,
    });

    const sent = second.receivedMessages[0];
    expect(sent.filter((m) => m.role === "system")).toHaveLength(1);
    expect(sent[0].role).toBe("system");
    expect(sent).toContainEqual({ role: "assistant", content: "first reply" });
    expect(sent.at(-1)).toEqual({ role: "user", content: "who are you?" });
  });

  it("records tool calls, tool results, and the final reply in newMessages", async () => {
    const { provider } = makeProvider([
      [
        { type: "tool_call_start", id: "call_1", name: "read" },
        { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      textTurn("done reading"),
    ]);

    const result = await runAgent("read a.txt", {
      provider,
      tools: [],
      executeTool: async () => ({ content: "file contents" }),
    });

    expect(result.newMessages).toEqual([
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a.txt" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "file contents" },
      { role: "assistant", content: "done reading" },
    ]);
  });

  describe("permissions.resolve integration", () => {
    const toolCallTurn = (): TurnScript => [
      { type: "tool_call_start", id: "call_1", name: "run_bash" },
      { type: "tool_call_delta", id: "call_1", arguments: '{"command":"npm test"}' },
      { type: "done", finishReason: "tool_calls" },
    ];

    it("denies and skips execution when resolve() returns deny", async () => {
      const { provider } = makeProvider([[...toolCallTurn()], textTurn("ok")]);
      const permissions = new PermissionEngine({ rules: [{ tool: "run_bash", kind: "any", pattern: "", action: "deny", origin: "config" }] }, "/workspace");
      const executeTool = vi.fn(async () => ({ content: "should not run" }));

      await runAgent("run tests", { provider, tools: [], executeTool, permissions });

      expect(executeTool).not.toHaveBeenCalled();
    });

    it("calls the provided askUser callback when resolve() returns ask, and proceeds on approval (simulates a sub-agent's ask-tier call surfacing to the parent UI instead of auto-denying)", async () => {
      const { provider } = makeProvider([[...toolCallTurn()], textTurn("ok")]);
      const permissions = new PermissionEngine(undefined, "/workspace");
      const executeTool = vi.fn(async () => ({ content: "ran" }));
      const askUser = vi.fn(async () => true);

      await runAgent("run tests", { provider, tools: [], executeTool, permissions, askUser });

      expect(askUser).toHaveBeenCalledWith("run_bash", { command: "npm test" });
      expect(executeTool).toHaveBeenCalled();
    });

    it("skips execution when askUser resolves false", async () => {
      const { provider } = makeProvider([[...toolCallTurn()], textTurn("ok")]);
      const permissions = new PermissionEngine(undefined, "/workspace");
      const executeTool = vi.fn(async () => ({ content: "should not run" }));
      const askUser = vi.fn(async () => false);

      await runAgent("run tests", { provider, tools: [], executeTool, permissions, askUser });

      expect(executeTool).not.toHaveBeenCalled();
    });

    it("auto-denies (headless) when resolve() returns ask but no askUser callback is provided", async () => {
      const { provider } = makeProvider([[...toolCallTurn()], textTurn("ok")]);
      const permissions = new PermissionEngine(undefined, "/workspace");
      const executeTool = vi.fn(async () => ({ content: "should not run" }));

      const result = await runAgent("run tests", { provider, tools: [], executeTool, permissions });

      expect(executeTool).not.toHaveBeenCalled();
      expect(result.newMessages.some((m) => m.role === "tool" && String(m.content).includes("headless"))).toBe(true);
    });
  });

  describe("permission audit logging", () => {
    function fakeSessionStore() {
      return { appendPermission: vi.fn(async () => {}), appendToken: vi.fn(async () => {}) };
    }

    it("logs a deny-by-rule decision when a rule denies the call outright", async () => {
      const { provider } = makeProvider([
        [
          { type: "tool_call_start", id: "call_1", name: "run_bash" },
          { type: "tool_call_delta", id: "call_1", arguments: '{"command":"rm -rf /"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
        textTurn("ok"),
      ]);
      const permissions = new PermissionEngine(undefined, "/workspace");
      const executeTool = vi.fn(async () => ({ content: "should not run" }));
      const sessionStore = fakeSessionStore();

      await runAgent("run", { provider, tools: [], executeTool, permissions, sessionStore: sessionStore as any, sessionId: "s1" });

      expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({
        tool: "run_bash",
        subject: "rm -rf /",
        decision: "deny-by-rule",
      }));
    });

    it("logs an allow-by-rule decision when a rule allows the call with no prompt needed", async () => {
      const { provider } = makeProvider([
        [
          { type: "tool_call_start", id: "call_1", name: "run_bash" },
          { type: "tool_call_delta", id: "call_1", arguments: '{"command":"npm test"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
        textTurn("ok"),
      ]);
      const permissions = new PermissionEngine(
        { rules: [{ tool: "run_bash", kind: "any", pattern: "", action: "allow", origin: "config" }] },
        "/workspace",
      );
      const executeTool = vi.fn(async () => ({ content: "ran" }));
      const sessionStore = fakeSessionStore();

      await runAgent("run", { provider, tools: [], executeTool, permissions, sessionStore: sessionStore as any, sessionId: "s1" });

      expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({
        tool: "run_bash",
        subject: "npm test",
        decision: "allow-by-rule",
      }));
    });

    it("logs an ask-approved decision when askUser approves the prompt", async () => {
      const { provider } = makeProvider([
        [
          { type: "tool_call_start", id: "call_1", name: "run_bash" },
          { type: "tool_call_delta", id: "call_1", arguments: '{"command":"npm test"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
        textTurn("ok"),
      ]);
      const permissions = new PermissionEngine(undefined, "/workspace");
      const executeTool = vi.fn(async () => ({ content: "ran" }));
      const sessionStore = fakeSessionStore();
      const askUser = vi.fn(async () => true);

      await runAgent("run", { provider, tools: [], executeTool, permissions, askUser, sessionStore: sessionStore as any, sessionId: "s1" });

      expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({
        tool: "run_bash",
        subject: "npm test",
        decision: "ask-approved",
      }));
    });

    it("logs an ask-denied decision when askUser rejects the prompt", async () => {
      const { provider } = makeProvider([
        [
          { type: "tool_call_start", id: "call_1", name: "run_bash" },
          { type: "tool_call_delta", id: "call_1", arguments: '{"command":"npm test"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
        textTurn("ok"),
      ]);
      const permissions = new PermissionEngine(undefined, "/workspace");
      const executeTool = vi.fn(async () => ({ content: "should not run" }));
      const sessionStore = fakeSessionStore();
      const askUser = vi.fn(async () => false);

      await runAgent("run", { provider, tools: [], executeTool, permissions, askUser, sessionStore: sessionStore as any, sessionId: "s1" });

      expect(executeTool).not.toHaveBeenCalled();
      expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({
        decision: "ask-denied",
      }));
    });

    it("logs a headless-deny decision for the headless-ask path", async () => {
      const { provider } = makeProvider([
        [
          { type: "tool_call_start", id: "call_1", name: "run_bash" },
          { type: "tool_call_delta", id: "call_1", arguments: '{"command":"npm test"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
        textTurn("ok"),
      ]);
      const permissions = new PermissionEngine(undefined, "/workspace");
      const executeTool = vi.fn(async () => ({ content: "should not run" }));
      const sessionStore = fakeSessionStore();

      await runAgent("run", { provider, tools: [], executeTool, permissions, sessionStore: sessionStore as any, sessionId: "s1" });

      expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({ decision: "headless-deny" }));
    });

    it("does not throw or log when permissions is absent entirely", async () => {
      const { provider } = makeProvider([textTurn("no tools here")]);
      const executeTool = vi.fn(async () => ({ content: "" }));
      const sessionStore = fakeSessionStore();

      await runAgent("hi", { provider, tools: [], executeTool, sessionStore: sessionStore as any, sessionId: "s1" });

      expect(sessionStore.appendPermission).not.toHaveBeenCalled();
    });
  });

  describe("token-usage logging", () => {
    function fakeSessionStore() {
      return {
        appendPermission: vi.fn(async (_id: string, _rec: unknown) => {}),
        appendToken: vi.fn(async (_id: string, _rec: unknown) => {}),
      };
    }

    it("records one token row per turn with the turn's reported usage", async () => {
      const provider: Provider = {
        name: "fake",
        async *streamChat() {
          yield { type: "text_delta", content: "hi" } as StreamEvent;
          yield { type: "usage", inputTokens: 100, outputTokens: 40 } as StreamEvent;
          yield { type: "done", finishReason: "stop" } as StreamEvent;
        },
      };
      const sessionStore = fakeSessionStore();

      await runAgent("hi", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "" }),
        sessionStore: sessionStore as any,
        sessionId: "s1",
        contextWindow: 200000,
      });

      expect(sessionStore.appendToken).toHaveBeenCalledTimes(1);
      expect(sessionStore.appendToken).toHaveBeenCalledWith("s1", expect.objectContaining({
        turnTokens: 140,
        budgetMax: 200000,
      }));
    });

    it("accumulates one token row per turn across a tool-call turn and the final turn", async () => {
      const provider = makeProvider([
        [
          { type: "tool_call_start", id: "call_1", name: "read" },
          { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
          { type: "usage", inputTokens: 200, outputTokens: 30 },
          { type: "done", finishReason: "tool_calls" },
        ],
        [
          { type: "text_delta", content: "done" },
          { type: "usage", inputTokens: 260, outputTokens: 10 },
          { type: "done", finishReason: "stop" },
        ],
      ]).provider;
      const sessionStore = fakeSessionStore();

      await runAgent("read a.txt", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "file contents" }),
        sessionStore: sessionStore as any,
        sessionId: "s1",
      });

      expect(sessionStore.appendToken).toHaveBeenCalledTimes(2);
      const firstCall = sessionStore.appendToken.mock.calls[0][1] as any;
      const secondCall = sessionStore.appendToken.mock.calls[1][1] as any;
      expect(firstCall.turnTokens).toBe(230);
      expect(secondCall.turnTokens).toBe(270);
      // totalUsed reflects live context growth across turns.
      expect(secondCall.totalUsed).toBeGreaterThanOrEqual(firstCall.totalUsed);
      // remaining is derived on read; budgetMax defaults to 128000.
      expect(firstCall.budgetMax).toBe(128000);
    });

    it("does not record token rows without a session store", async () => {
      const { provider } = makeProvider([textTurn("hi")]);
      // No sessionStore/sessionId — must not throw.
      await runAgent("hi", { provider, tools: [], executeTool: async () => ({ content: "" }) });
    });
  });

  describe("errorReflector engagement", () => {
    const failingToolTurn = (): TurnScript => [
      { type: "tool_call_start", id: "call_1", name: "read" },
      { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
      { type: "done", finishReason: "tool_calls" },
    ];

    it("injects a reflection prompt after a failed tool result when a reflector is passed", async () => {
      const { provider } = makeProvider([failingToolTurn(), textTurn("recovered")]);
      const onRetry = vi.fn();

      const result = await runAgent("read a.txt", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "", error: "ENOENT: no such file" }),
        errorReflector: new ErrorReflector(),
        onRetry,
      });

      // The reflector's formatError message is injected as a user turn.
      const reflection = result.messages.find(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Try a different approach"),
      );
      expect(reflection).toBeDefined();
      expect(reflection?.content).toContain("read");
      expect(reflection?.content).toContain("ENOENT");
      expect(onRetry).toHaveBeenCalledWith("retrying");
    });

    it("does not inject a reflection prompt without a reflector (proves it was inert before wiring)", async () => {
      const { provider } = makeProvider([failingToolTurn(), textTurn("gave up")]);

      const result = await runAgent("read a.txt", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "", error: "ENOENT: no such file" }),
      });

      const reflection = result.messages.find(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Try a different approach"),
      );
      expect(reflection).toBeUndefined();
    });

    it("does not retry a permission-denied error", async () => {
      const { provider } = makeProvider([failingToolTurn(), textTurn("done")]);
      const onRetry = vi.fn();

      await runAgent("read a.txt", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "", error: "Permission denied for read" }),
        errorReflector: new ErrorReflector(),
        onRetry,
      });

      expect(onRetry).not.toHaveBeenCalled();
    });
  });

  describe("errorRecovery engagement", () => {
    const malformedToolTurn = (): TurnScript => [
      { type: "tool_call_start", id: "call_1", name: "read" },
      { type: "tool_call_delta", id: "call_1", arguments: "{not valid json" },
      { type: "done", finishReason: "tool_calls" },
    ];

    it("injects a JSON-correction prompt on malformed tool args when recovery is passed", async () => {
      const { provider } = makeProvider([malformedToolTurn(), textTurn("fixed")]);
      const executeTool = vi.fn(async () => ({ content: "should not run" }));

      const result = await runAgent("read a.txt", {
        provider,
        tools: [],
        executeTool,
        errorRecovery: new ErrorRecovery(),
      });

      // The malformed call is not executed; a correction system message is injected.
      expect(executeTool).not.toHaveBeenCalled();
      const correction = result.messages.find(
        (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("malformed tool arguments"),
      );
      expect(correction).toBeDefined();
    });

    it("without recovery, malformed args are passed through to the tool as _raw (proves it was inert before wiring)", async () => {
      const { provider } = makeProvider([malformedToolTurn(), textTurn("whatever")]);
      const executeTool = vi.fn(async (_call: { arguments: Record<string, unknown> }) => ({ content: "ran anyway" }));

      const result = await runAgent("read a.txt", {
        provider,
        tools: [],
        executeTool,
      });

      // No correction message; the raw args reach executeTool.
      const correction = result.messages.find(
        (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("malformed tool arguments"),
      );
      expect(correction).toBeUndefined();
      expect(executeTool).toHaveBeenCalled();
      expect(executeTool.mock.calls[0][0].arguments).toEqual({ _raw: "{not valid json" });
    });

    // A fault in the turn body *after* the provider stream (here: executeTool
    // throwing, which is not the captured-error path) is what handleFatalError
    // is for. Provider stream errors are deliberately NOT swallowed (see the
    // provider-stream-error test below).
    const toolCallTurn = (): TurnScript => [
      { type: "tool_call_start", id: "call_1", name: "read" },
      { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
      { type: "done", finishReason: "tool_calls" },
    ];

    it("converts a fatal turn-body exception into a preserved-state system message instead of throwing", async () => {
      const { provider } = makeProvider([toolCallTurn(), textTurn("unreached")]);

      const result = await runAgent("go", {
        provider,
        tools: [],
        executeTool: async () => {
          throw new Error("kaboom");
        },
        errorRecovery: new ErrorRecovery(),
      });

      const fatal = result.messages.find(
        (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("A fatal error occurred: kaboom"),
      );
      expect(fatal).toBeDefined();
    });

    it("without recovery, a fatal turn-body exception propagates (proves it was inert before wiring)", async () => {
      const { provider } = makeProvider([toolCallTurn(), textTurn("unreached")]);

      await expect(
        runAgent("go", {
          provider,
          tools: [],
          executeTool: async () => {
            throw new Error("kaboom");
          },
        }),
      ).rejects.toThrow("kaboom");
    });

    it("does NOT swallow provider stream errors even with recovery (headless must still surface them)", async () => {
      const provider: Provider = {
        name: "boom",
        async *streamChat() {
          throw new Error("HTTP 401: auth failed");
        },
      };

      await expect(
        runAgent("go", {
          provider,
          tools: [],
          executeTool: async () => ({ content: "" }),
          errorRecovery: new ErrorRecovery(),
        }),
      ).rejects.toThrow("HTTP 401");
    });
  });

  describe("large tool-call args diagnostic", () => {
    const toolCallTurnWithArgs = (args: string): TurnScript => [
      { type: "tool_call_start", id: "call_1", name: "write" },
      { type: "tool_call_delta", id: "call_1", arguments: args },
      { type: "done", finishReason: "tool_calls" },
    ];

    it("fires onDiagnostic for oversized args without affecting the parsed result", async () => {
      const bigValue = "x".repeat(300 * 1024); // over the 256KB threshold
      const bigArgs = JSON.stringify({ content: bigValue });
      const { provider } = makeProvider([toolCallTurnWithArgs(bigArgs), textTurn("done")]);
      const executeTool = vi.fn(async (_call: { arguments: Record<string, unknown> }) => ({ content: "" }));
      const onDiagnostic = vi.fn();

      await runAgent("write a big file", {
        provider,
        tools: [],
        executeTool,
        onDiagnostic,
      });

      expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining("write"));
      expect(executeTool.mock.calls[0][0].arguments).toEqual({ content: bigValue });
    });

    it("does NOT fire onDiagnostic for normal-sized args", async () => {
      const smallArgs = JSON.stringify({ path: "a.txt" });
      const { provider } = makeProvider([toolCallTurnWithArgs(smallArgs), textTurn("done")]);
      const executeTool = vi.fn(async (_call: { arguments: Record<string, unknown> }) => ({ content: "" }));
      const onDiagnostic = vi.fn();

      await runAgent("write a small file", {
        provider,
        tools: [],
        executeTool,
        onDiagnostic,
      });

      expect(onDiagnostic).not.toHaveBeenCalled();
      expect(executeTool.mock.calls[0][0].arguments).toEqual({ path: "a.txt" });
    });
  });
});
