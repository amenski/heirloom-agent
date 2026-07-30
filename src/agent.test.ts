import { describe, it, expect, vi } from "vitest";
import { runAgent } from "./agent.js";
import { PermissionEngine } from "./permissions/index.js";
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
      return { appendPermission: vi.fn(async () => {}) };
    }

    it("logs a deny decision when a rule denies the call outright", async () => {
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
        decision: "deny",
      }));
    });

    it("logs a once decision when a rule allows the call with no prompt needed", async () => {
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
        decision: "once",
      }));
    });

    it("does not double-log when askUser is provided and prompts (App.tsx owns that log line)", async () => {
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

      expect(sessionStore.appendPermission).not.toHaveBeenCalled();
    });

    it("logs a deny decision for the headless-ask-becomes-deny path", async () => {
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

      expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({ decision: "deny" }));
    });

    it("does not throw or log when permissions is absent entirely", async () => {
      const { provider } = makeProvider([textTurn("no tools here")]);
      const executeTool = vi.fn(async () => ({ content: "" }));
      const sessionStore = fakeSessionStore();

      await runAgent("hi", { provider, tools: [], executeTool, sessionStore: sessionStore as any, sessionId: "s1" });

      expect(sessionStore.appendPermission).not.toHaveBeenCalled();
    });
  });
});
