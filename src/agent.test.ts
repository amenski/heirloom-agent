import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgent } from "./agent.js";
import { PermissionEngine } from "./permissions/index.js";
import { Compactor } from "./compaction/compactor.js";
import { ErrorReflector } from "./selfreflection/index.js";
import { ErrorRecovery } from "./errorrecovery/index.js";
import type { Provider, StreamEvent } from "./providers/types.js";
import type { Message, ToolCall } from "./types.js";
import { todoStore } from "./tools/todo.js";
import { executeTool } from "./tools/index.js";

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

  describe("parallel mixed batches", () => {
    const mixedTurn = (): TurnScript => [
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
      { type: "tool_call_start", id: "call_2", name: "write_to_file" },
      { type: "tool_call_delta", id: "call_2", arguments: '{"path":"out.txt","content":"x"}' },
      { type: "tool_call_start", id: "call_3", name: "read_file" },
      { type: "tool_call_delta", id: "call_3", arguments: '{"path":"b.txt"}' },
      { type: "done", finishReason: "tool_calls" },
    ];

    // Default engine allows in-tree reads via the builtin "./**" rules; the
    // write is allowed by an explicit rule so ordering tests stay focused on
    // concurrency rather than prompting.
    const mixedPermissions = () => new PermissionEngine(
      { rules: [{ tool: "write_to_file", kind: "any", pattern: "", action: "allow", origin: "config" }] },
      "/workspace",
    );

    function fakeSessionStore() {
      return { appendPermission: vi.fn(async () => {}), appendToken: vi.fn(async () => {}) };
    }

    it("runs reads concurrently and writes sequentially after them", async () => {
      const { provider } = makeProvider([mixedTurn(), textTurn("done")]);
      const log: string[] = [];
      let readsStarted = 0;
      let readsDone: () => void = () => {};
      const readsInFlight = new Promise<void>((r) => { readsDone = r; });
      const executeTool = vi.fn(async (call: ToolCall) => {
        log.push(`start:${call.name}`);
        if (call.name === "read_file") {
          readsStarted++;
          if (readsStarted === 2) readsDone();
          // Hold both reads in flight until the second has started — if the
          // batch were serial, the first read would await forever.
          await readsInFlight;
        }
        return { content: "ok" };
      });

      await runAgent("do it", {
        provider,
        tools: [],
        executeTool,
        permissions: mixedPermissions(),
      });

      // Both reads are in flight before either returns, and the write only
      // starts once the reads have settled.
      expect(log).toEqual([
        "start:read_file",
        "start:read_file",
        "start:write_to_file",
      ]);
    });

    it("replays tool results in the assistant's original toolCalls order", async () => {
      const { provider } = makeProvider([mixedTurn(), textTurn("done")]);
      const executeTool = vi.fn(async (call: ToolCall) => {
        if (call.name === "read_file" && call.arguments.path === "a.txt") {
          // Slow first read: a completion-order replay would emit call_3's
          // result before call_1's.
          await new Promise((r) => setTimeout(r, 25));
        }
        return { content: `result:${call.arguments.path}` };
      });

      const result = await runAgent("do it", {
        provider,
        tools: [],
        executeTool,
        permissions: mixedPermissions(),
      });

      const toolResults = result.newMessages
        .filter((m) => m.role === "tool")
        .map((m) => m.content);
      expect(toolResults).toEqual([
        "result:a.txt",
        "result:out.txt",
        "result:b.txt",
      ]);
    });

    it("records a deny-by-rule audit row for a denied call in a mixed batch", async () => {
      const { provider } = makeProvider([
        [
          { type: "tool_call_start", id: "call_1", name: "read_file" },
          { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
          { type: "tool_call_start", id: "call_2", name: "run_bash" },
          { type: "tool_call_delta", id: "call_2", arguments: '{"command":"rm -rf /"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
        textTurn("ok"),
      ]);
      const executeTool = vi.fn(async (call: ToolCall) => ({ content: `result:${call.name}` }));
      const sessionStore = fakeSessionStore();

      await runAgent("do it", {
        provider,
        tools: [],
        executeTool,
        permissions: new PermissionEngine(undefined, "/workspace"),
        sessionStore: sessionStore as any,
        sessionId: "s1",
      });

      expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({
        tool: "run_bash",
        subject: "rm -rf /",
        decision: "deny-by-rule",
      }));
      // The denied call never executed; the parallel read did.
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ name: "read_file" }));
    });

    it("prompts exactly once for an ask call in a mixed batch", async () => {
      const { provider } = makeProvider([
        [
          { type: "tool_call_start", id: "call_1", name: "read_file" },
          { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
          { type: "tool_call_start", id: "call_2", name: "run_bash" },
          { type: "tool_call_delta", id: "call_2", arguments: '{"command":"npm test"}' },
          { type: "tool_call_start", id: "call_3", name: "read_file" },
          { type: "tool_call_delta", id: "call_3", arguments: '{"path":"b.txt"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
        textTurn("done"),
      ]);
      const askUser = vi.fn(async () => true);
      const executeTool = vi.fn(async (call: ToolCall) => ({ content: `result:${call.name}` }));
      const sessionStore = fakeSessionStore();

      await runAgent("do it", {
        provider,
        tools: [],
        executeTool,
        permissions: new PermissionEngine(undefined, "/workspace"),
        askUser,
        sessionStore: sessionStore as any,
        sessionId: "s1",
      });

      // The ask resolved once — no double prompt, and all three calls ran
      // (the reads concurrently, the ask sequentially in between).
      expect(askUser).toHaveBeenCalledTimes(1);
      expect(askUser).toHaveBeenCalledWith("run_bash", { command: "npm test" });
      expect(executeTool).toHaveBeenCalledTimes(3);
      expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({
        tool: "run_bash",
        decision: "ask-approved",
      }));
    });

    it("emits allow-by-posture when an auto-approve posture upgrades an ask", async () => {
      const { provider } = makeProvider([
        [
          { type: "tool_call_start", id: "call_1", name: "read_file" },
          { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
          { type: "tool_call_start", id: "call_2", name: "run_bash" },
          { type: "tool_call_delta", id: "call_2", arguments: '{"command":"npm test"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
        textTurn("done"),
      ]);
      const askUser = vi.fn(async (): Promise<boolean | "posture"> => "posture");
      const executeTool = vi.fn(async (call: ToolCall) => ({ content: `result:${call.name}` }));
      const sessionStore = fakeSessionStore();

      await runAgent("do it", {
        provider,
        tools: [],
        executeTool,
        permissions: new PermissionEngine(undefined, "/workspace"),
        askUser,
        sessionStore: sessionStore as any,
        sessionId: "s1",
      });

      expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({
        tool: "run_bash",
        decision: "allow-by-posture",
      }));
      // Upgraded by posture, not denied — the call still executed.
      expect(askUser).toHaveBeenCalledTimes(1);
      expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ name: "run_bash" }));
    });

    it("acts on failedStreak (5 consecutive failures) in a parallel batch", async () => {
      const failingTurn: TurnScript = [];
      for (let i = 1; i <= 5; i++) {
        failingTurn.push(
          { type: "tool_call_start", id: `call_${i}`, name: "read_file" },
          { type: "tool_call_delta", id: `call_${i}`, arguments: JSON.stringify({ path: `f${i}.txt` }) },
        );
      }
      failingTurn.push(
        { type: "tool_call_start", id: "call_6", name: "write_to_file" },
        { type: "tool_call_delta", id: "call_6", arguments: '{"path":"out.txt","content":"x"}' },
        { type: "done", finishReason: "tool_calls" },
      );
      const { provider, receivedMessages } = makeProvider([failingTurn]);
      const executeTool = vi.fn(async (call: ToolCall) =>
        call.name === "read_file" ? { content: "", error: "ENOENT" } : { content: "write ran" });

      const result = await runAgent("read everything", {
        provider,
        tools: [],
        executeTool,
        permissions: new PermissionEngine(undefined, "/workspace"),
      });

      // The 5th consecutive failure escalates exactly like the sequential
      // loop: warning injected and the turn ends — the write after the reads
      // never runs, and the loop does not continue to a second provider call.
      expect(result.messages.some(
        (m) => m.role === "system" && String(m.content).includes("5 consecutive tool calls have failed"),
      )).toBe(true);
      expect(executeTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "write_to_file" }));
      expect(receivedMessages).toHaveLength(1);
    });
  });

  describe("mid-turn steering (pollSteeringMessage)", () => {
    const toolTurn = (): TurnScript => [
      { type: "tool_call_start", id: "call_1", name: "read" },
      { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
      { type: "done", finishReason: "tool_calls" },
    ];

    it("injects a queued message before the next provider call, never mid-stream", async () => {
      const { provider, receivedMessages } = makeProvider([toolTurn(), textTurn("steered")]);
      const poll = vi.fn()
        .mockReturnValueOnce(null)                     // before the first call: nothing queued yet
        .mockReturnValueOnce("stop what you're doing") // before the second call: the steering hit

      await runAgent("read a.txt", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "file contents" }),
        pollSteeringMessage: poll,
      });

      // The first request is untouched; the second carries the steering block
      // in its volatile prefix (attached to the pushed user message).
      expect(JSON.stringify(receivedMessages[0])).not.toContain("typed mid-turn");
      expect(JSON.stringify(receivedMessages[1])).toContain("User message (typed mid-turn): stop what you're doing");
      // Polled exactly once per decision point (two provider calls).
      expect(poll).toHaveBeenCalledTimes(2);
    });

    it("persists the injected message as a real user message in the conversation", async () => {
      const { provider } = makeProvider([toolTurn(), textTurn("steered")]);
      const poll = vi.fn()
        .mockReturnValueOnce("stop what you're doing")
        .mockReturnValueOnce(null);

      const result = await runAgent("read a.txt", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "file contents" }),
        pollSteeringMessage: poll,
      });

      // The stored message is the raw typed text — not the volatile-prefix
      // wrapper — and it sits before the assistant reply that responds to it,
      // so the session record's ordering stays honest.
      const steeringIdx = result.messages.findIndex(
        (m) => m.role === "user" && m.content === "stop what you're doing",
      );
      expect(steeringIdx).toBeGreaterThan(-1);
      expect(result.messages[steeringIdx]).toEqual({ role: "user", content: "stop what you're doing" });
      const after = result.messages.slice(steeringIdx + 1);
      // The tool-call assistant message has content null; the text reply that
      // follows the steering message carries the actual response.
      expect(after.find((m) => m.role === "assistant" && m.content)?.content).toBe("steered");
    });

    it("consumes a queued message exactly once — the second poll returns null", async () => {
      let queued: string | null = "steer me";
      const { provider, receivedMessages } = makeProvider([toolTurn(), textTurn("done")]);
      const polls: (string | null)[] = [];

      await runAgent("read a.txt", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "file contents" }),
        pollSteeringMessage: () => {
          const hit = queued;
          queued = null;
          polls.push(hit);
          return hit;
        },
      });

      expect(polls).toEqual(["steer me", null]);
      // The message appears in exactly one provider request — not replayed.
      const withSteering = receivedMessages.filter((req) => JSON.stringify(req).includes("typed mid-turn"));
      expect(withSteering).toHaveLength(1);
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

  describe("update_todo_list integration (real registry)", () => {
    // Drives the REAL tool registry + permission engine + todo store through
    // the loop, so this is an end-to-end test of registration, the builtin
    // allow rule (no permission prompt on check-offs), and the live per-sub-
    // turn context injection at the request-build site.
    beforeEach(() => todoStore.reset());

    const planTurn = (): TurnScript => [
      { type: "tool_call_start", id: "c1", name: "update_todo_list" },
      { type: "tool_call_delta", id: "c1", arguments: JSON.stringify({
        todos: [
          { content: "Add F feedrate capture", status: "pending" },
          { content: "Per-segment time math", status: "in_progress" },
          { content: "UI row in the pro gate", status: "completed" },
        ],
      }) },
      { type: "done", finishReason: "tool_calls" },
    ];

    const progressTurn = (): TurnScript => [
      { type: "tool_call_start", id: "c2", name: "update_todo_list" },
      { type: "tool_call_delta", id: "c2", arguments: JSON.stringify({
        todos: [
          { content: "Add F feedrate capture", status: "completed" },
          { content: "Per-segment time math", status: "in_progress" },
          { content: "UI row in the pro gate", status: "pending" },
        ],
      }) },
      { type: "done", finishReason: "tool_calls" },
    ];

    it("executes without a permission prompt and injects the live list into each sub-turn request", async () => {
      const { provider, receivedMessages } = makeProvider([planTurn(), progressTurn(), textTurn("all done")]);
      const askUser = vi.fn(async () => true);

      const result = await runAgent("build the feedrate feature", {
        provider,
        tools: [],
        executeTool, // real registry — the real handler writes the real store
        permissions: new PermissionEngine(undefined, "/workspace"), // default askAll + builtin allow rules
        askUser,
        getTodos: () => todoStore.getTodos(),
      });

      // The builtin allow rule means the check-offs never hit the permission
      // prompt; had the rule been missing, askUser would have been called.
      expect(askUser).not.toHaveBeenCalled();

      // Store holds the final plan (the second update replaced the first).
      expect(todoStore.getTodos()).toEqual([
        { content: "Add F feedrate capture", status: "completed" },
        { content: "Per-segment time math", status: "in_progress" },
        { content: "UI row in the pro gate", status: "pending" },
      ]);

      // The model-facing tool output returns the updated list.
      expect(result.newMessages.some(
        (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("Todo list updated (3 items)"),
      )).toBe(true);

      // Turn 1 request: list is empty, so no todo block is injected.
      expect(JSON.stringify(receivedMessages[0])).not.toContain("# Current todo list");

      // Turn 2 request: reflects the state after turn 1's update (live, not a
      // stale snapshot computed once at run start).
      expect(JSON.stringify(receivedMessages[1])).toContain("# Current todo list");
      expect(JSON.stringify(receivedMessages[1])).toContain("- [pending] Add F feedrate capture");
      expect(JSON.stringify(receivedMessages[1])).toContain("- [in_progress] Per-segment time math");
      expect(JSON.stringify(receivedMessages[1])).toContain("- [completed] UI row in the pro gate");

      // Turn 3 request: reflects turn 2's check-off.
      expect(JSON.stringify(receivedMessages[2])).toContain("- [completed] Add F feedrate capture");
      expect(JSON.stringify(receivedMessages[2])).toContain("- [pending] UI row in the pro gate");
    });

    it("does not inject the todo block when getTodos is absent (sub-agent contract)", async () => {
      const { provider, receivedMessages } = makeProvider([planTurn(), textTurn("ok")]);

      await runAgent("plan it", {
        provider,
        tools: [],
        executeTool,
      });

      // The handler still ran and wrote the shared store, but the sub-agent's
      // volatile prefix never carries the list (the tool result below still
      // shows it — that's the handler's output, not a prefix injection).
      expect(todoStore.getTodos()).toHaveLength(3);
      const userMsg = receivedMessages[1].find((m) => m.role === "user")!;
      expect(String(userMsg.content)).not.toContain("# Current todo list");
    });
  });

  describe("attempt_completion — tool-initiated turn end", () => {
    it("ends the turn after the tool result without another provider call", async () => {
      const { provider, receivedMessages } = makeProvider([
        [
          { type: "tool_call_start", id: "c1", name: "attempt_completion" },
          { type: "tool_call_delta", id: "c1", arguments: '{"summary":"done: 3 files"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
        // A second turn would be scripted here if the loop continued — its
        // absence is the assertion: receivedMessages stays at length 1.
      ]);
      const executeTool = vi.fn(async () => ({ content: "done: 3 files", stop: true }));

      const result = await runAgent("finish the task", {
        provider,
        tools: [],
        executeTool,
      });

      expect(receivedMessages).toHaveLength(1);
      expect(result.stopReason).toBe("done");
      // The tool result made it into the transcript.
      expect(result.messages.some(
        (m) => m.role === "tool" && m.content === "done: 3 files",
      )).toBe(true);
      expect(executeTool).toHaveBeenCalledTimes(1);
    });

    it("executes through the real registry without a permission prompt (builtin allow)", async () => {
      const { provider, receivedMessages } = makeProvider([
        [
          { type: "tool_call_start", id: "c1", name: "attempt_completion" },
          { type: "tool_call_delta", id: "c1", arguments: '{"summary":"done"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
      ]);
      const askUser = vi.fn(async () => true);

      await runAgent("finish", {
        provider,
        tools: [],
        executeTool, // real registry — real handler returns stop: true
        permissions: new PermissionEngine(undefined, "/workspace"),
        askUser,
      });

      // The builtin allow rule means the final call never hits the prompt;
      // had the rule been missing, askUser would have been called.
      expect(askUser).not.toHaveBeenCalled();
      expect(receivedMessages).toHaveLength(1);
    });

    it("does not prompt on switch_mode either (builtin allow, auto-switch design)", async () => {
      const { provider } = makeProvider([
        [
          { type: "tool_call_start", id: "c1", name: "switch_mode" },
          { type: "tool_call_delta", id: "c1", arguments: '{"slug":"architect"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
      ]);
      const askUser = vi.fn(async () => true);

      await runAgent("switch modes", {
        provider,
        tools: [],
        executeTool, // real registry — real handler
        permissions: new PermissionEngine(undefined, "/workspace"),
        askUser,
      });

      // The builtin allow rule means the switch never hits the permission
      // prompt — consistent with the auto-switch, no-confirmation design.
      expect(askUser).not.toHaveBeenCalled();
    });

    it("does not end the turn when a tool returns stop: false/undefined", async () => {
      const { provider, receivedMessages } = makeProvider([
        [
          { type: "tool_call_start", id: "c1", name: "read" },
          { type: "tool_call_delta", id: "c1", arguments: '{"path":"a.txt"}' },
          { type: "done", finishReason: "tool_calls" },
        ],
        textTurn("all done"),
      ]);

      await runAgent("read a.txt", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "file contents" }),
      });

      // The loop continued to a second turn (final text reply).
      expect(receivedMessages).toHaveLength(2);
    });
  });

  describe("pre-request compaction", () => {
    it("compacts before the provider call, so the provider sees the compacted set", async () => {
      const { provider, receivedMessages } = makeProvider([textTurn("done")]);
      const fakeCompactor = {
        needsCompaction: vi.fn(() => true),
        // Mirrors the real Compactor: drop everything except a summary plus
        // the trailing (most recent) message.
        compact: vi.fn(async (msgs: Message[]) => [
          { role: "system", content: "[Previous conversation summary]\ncompacted" },
          msgs[msgs.length - 1],
        ] as Message[]),
        getLastCompaction: vi.fn(() => ({ summary: "compacted", files: [] })),
      };

      // A long prior history that would trip needsCompaction if it were real —
      // the fake always returns true, so this just needs to exist as history.
      const history: Message[] = [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: "x".repeat(1000) },
      ];

      await runAgent("hi", {
        provider,
        tools: [],
        executeTool: async () => ({ content: "" }),
        compactor: fakeCompactor as any,
        history,
      });

      // needsCompaction was consulted before the provider call, and the
      // request the provider received reflects the compacted (shorter) set.
      expect(fakeCompactor.needsCompaction).toHaveBeenCalled();
      expect(fakeCompactor.compact).toHaveBeenCalled();
      const sentMessages = receivedMessages[0];
      expect(sentMessages.length).toBe(2); // compacted system msg + new user msg
      expect(sentMessages.some((m) => m.content === history[1].content)).toBe(false);
    });
  });
});

describe("lifecycle hooks (§5 ordering)", () => {
  function fakeHooks(impl?: (event: string, extra: Record<string, unknown>) => Promise<{ blocked: boolean; stdout?: string }>) {
    return {
      dispatch: vi.fn(impl ?? (async () => ({ blocked: false, stdout: "" }))),
    } as any;
  }

  function fakeSessionStore() {
    return {
      appendPermission: vi.fn(async () => {}),
      appendToken: vi.fn(async () => {}),
      getMessageCount: vi.fn(async () => 5),
      appendCompaction: vi.fn(async () => {}),
    };
  }

  const bashCallTurn: TurnScript = [
    { type: "tool_call_start", id: "call_1", name: "run_bash" },
    { type: "tool_call_delta", id: "call_1", arguments: '{"command":"npm test"}' },
    { type: "done", finishReason: "tool_calls" },
  ];

  it("a PreToolUse deny on an allow-tier call records deny-by-rule and blocks execution", async () => {
    const { provider } = makeProvider([bashCallTurn, textTurn("ok")]);
    const permissions = new PermissionEngine(
      { rules: [{ tool: "run_bash", kind: "any", pattern: "", action: "allow", origin: "config" }] },
      "/workspace",
    );
    const executeTool = vi.fn(async () => ({ content: "ran" }));
    const sessionStore = fakeSessionStore();
    const hooks = fakeHooks(async (event) => ({
      blocked: event === "PreToolUse",
      stdout: "",
    }));

    const result = await runAgent("run", { provider, tools: [], executeTool, permissions, sessionStore: sessionStore as any, sessionId: "s1", hooks });

    expect(executeTool).not.toHaveBeenCalled();
    const toolMsg = result.messages.find((m) => m.role === "tool") as Message;
    expect(toolMsg.content).toBe("PERMISSION_DENIED: denied by PreToolUse hook");
    expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({
      tool: "run_bash",
      decision: "deny-by-rule",
      reason: "deny rule matched (PreToolUse hook)",
    }));
  });

  it("a PermissionRequest deny is recorded as ask-denied and the user is never prompted", async () => {
    const { provider } = makeProvider([bashCallTurn, textTurn("ok")]);
    const permissions = new PermissionEngine(undefined, "/workspace");
    const executeTool = vi.fn(async () => ({ content: "ran" }));
    const sessionStore = fakeSessionStore();
    const askUser = vi.fn(async () => true);
    const hooks = fakeHooks(async (event) => ({
      blocked: event === "PermissionRequest",
      stdout: "",
    }));

    const result = await runAgent("run", { provider, tools: [], executeTool, permissions, askUser, sessionStore: sessionStore as any, sessionId: "s1", hooks });

    expect(askUser).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
    const toolMsg = result.messages.find((m) => m.role === "tool") as Message;
    expect(toolMsg.content).toBe("PERMISSION_DENIED: denied by PermissionRequest hook");
    expect(sessionStore.appendPermission).toHaveBeenCalledWith("s1", expect.objectContaining({
      decision: "ask-denied",
      reason: "denied by PermissionRequest hook",
    }));
  });

  it("a user deny at the prompt skips PreToolUse hooks entirely", async () => {
    const { provider } = makeProvider([bashCallTurn, textTurn("ok")]);
    const permissions = new PermissionEngine(undefined, "/workspace");
    const executeTool = vi.fn(async () => ({ content: "ran" }));
    const sessionStore = fakeSessionStore();
    const askUser = vi.fn(async () => false);
    const hooks = fakeHooks();

    await runAgent("run", { provider, tools: [], executeTool, permissions, askUser, sessionStore: sessionStore as any, sessionId: "s1", hooks });

    expect(hooks.dispatch).toHaveBeenCalledWith("PermissionRequest", expect.anything());
    expect(hooks.dispatch).not.toHaveBeenCalledWith("PreToolUse", expect.anything());
  });

  it("approved asks pass through PermissionRequest then PreToolUse in order", async () => {
    const { provider } = makeProvider([bashCallTurn, textTurn("ok")]);
    const permissions = new PermissionEngine(undefined, "/workspace");
    const executeTool = vi.fn(async () => ({ content: "ran" }));
    const sessionStore = fakeSessionStore();
    const askUser = vi.fn(async () => true);
    const events: string[] = [];
    const hooks = fakeHooks(async (event) => {
      events.push(event);
      return { blocked: false, stdout: "" };
    });

    await runAgent("run", { provider, tools: [], executeTool, permissions, askUser, sessionStore: sessionStore as any, sessionId: "s1", hooks });

    expect(askUser).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["PermissionRequest", "PreToolUse", "PostToolUse", "PostToolBatch"]);
  });

  it("an exit-0 {decision: allow} never upgrades a rule-derived ask", async () => {
    const { provider } = makeProvider([bashCallTurn, textTurn("ok")]);
    const permissions = new PermissionEngine(undefined, "/workspace");
    const executeTool = vi.fn(async () => ({ content: "ran" }));
    const sessionStore = fakeSessionStore();
    const askUser = vi.fn(async () => true);
    const hooks = fakeHooks(async () => ({ blocked: false, stdout: '{"decision":"allow"}' }));

    await runAgent("run", { provider, tools: [], executeTool, permissions, askUser, sessionStore: sessionStore as any, sessionId: "s1", hooks });

    // The rule-derived ask still surfaces — advisory-only power (decision G).
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("appends PostToolUse stdout to the tool result", async () => {
    const { provider } = makeProvider([bashCallTurn, textTurn("ok")]);
    const permissions = new PermissionEngine(
      { rules: [{ tool: "run_bash", kind: "any", pattern: "", action: "allow", origin: "config" }] },
      "/workspace",
    );
    const executeTool = vi.fn(async () => ({ content: "base" }));
    const hooks = fakeHooks(async (event) => ({
      blocked: false,
      stdout: event === "PostToolUse" ? "HOOK NOTE" : "",
    }));

    const result = await runAgent("run", { provider, tools: [], executeTool, permissions, hooks });

    const toolMsg = result.messages.find((m) => m.role === "tool") as Message;
    expect(toolMsg.content).toBe("base\nHOOK NOTE");
  });

  it("appends PostToolUseFailure stdout to the failure result", async () => {
    const { provider } = makeProvider([bashCallTurn, textTurn("ok")]);
    const permissions = new PermissionEngine(
      { rules: [{ tool: "run_bash", kind: "any", pattern: "", action: "allow", origin: "config" }] },
      "/workspace",
    );
    const executeTool = vi.fn(async () => ({ content: "", error: "boom" }));
    const hooks = fakeHooks(async (event) => ({
      blocked: false,
      stdout: event === "PostToolUseFailure" ? "HOOK NOTE" : "",
    }));

    const result = await runAgent("run", { provider, tools: [], executeTool, permissions, hooks });

    const toolMsg = result.messages.find((m) => m.role === "tool") as Message;
    expect(toolMsg.content).toBe("Error: boom\nHOOK NOTE");
  });

  it("fires PostToolBatch once per batch with the tool names", async () => {
    const { provider } = makeProvider([
      [
        { type: "tool_call_start", id: "call_1", name: "read" },
        { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
        { type: "tool_call_start", id: "call_2", name: "read" },
        { type: "tool_call_delta", id: "call_2", arguments: '{"path":"b.txt"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      textTurn("ok"),
    ]);
    const executeTool = vi.fn(async () => ({ content: "c" }));
    const hooks = fakeHooks();

    await runAgent("run", { provider, tools: [], executeTool, hooks });

    expect(hooks.dispatch).toHaveBeenCalledWith("PostToolBatch", { tool_calls: ["read", "read"] });
  });

  it("hooks never see calls a rule denied outright", async () => {
    const { provider } = makeProvider([bashCallTurn, textTurn("ok")]);
    const permissions = new PermissionEngine(
      { rules: [{ tool: "run_bash", kind: "any", pattern: "", action: "deny", origin: "config" }] },
      "/workspace",
    );
    const executeTool = vi.fn(async () => ({ content: "ran" }));
    const hooks = fakeHooks();

    await runAgent("run", { provider, tools: [], executeTool, permissions, hooks });

    expect(hooks.dispatch).not.toHaveBeenCalled();
  });

  it("routes PreCompact stdout into the compaction prompt and fires PostCompact after", async () => {
    const { provider: runProvider } = makeProvider([
      [
        { type: "tool_call_start", id: "call_1", name: "read" },
        { type: "tool_call_delta", id: "call_1", arguments: '{"path":"a.txt"}' },
        { type: "tool_call_start", id: "call_2", name: "read" },
        { type: "tool_call_delta", id: "call_2", arguments: '{"path":"b.txt"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      textTurn("done"),
    ]);
    const { provider: summaryProvider, receivedMessages: summaryMessages } = makeProvider([
      [
        { type: "text_delta", content: "the summary" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    // threshold 0 forces compaction on every check.
    const compactor = new Compactor(summaryProvider, 128000, 0, true);
    const executeTool = vi.fn(async () => ({ content: "c" }));
    const hooks = fakeHooks(async (event) => ({
      blocked: false,
      stdout: event === "PreCompact" ? "HOOK CONTEXT" : "",
    }));

    await runAgent("run", {
      provider: runProvider,
      tools: [],
      executeTool,
      compactor,
      hooks,
    });

    // The compaction request the provider saw carries the hook stdout appended
    // to the compaction prompt.
    expect(summaryMessages.length).toBeGreaterThan(0);
    const prompt = summaryMessages[0][0] as Message;
    expect(prompt.content).toContain("HOOK CONTEXT");
    expect(hooks.dispatch).toHaveBeenCalledWith("PreCompact", {});
    expect(hooks.dispatch).toHaveBeenCalledWith("PostCompact", {});
  });

  it("fires a PreToolUse deny even without a permission engine", async () => {
    const { provider } = makeProvider([bashCallTurn, textTurn("ok")]);
    const executeTool = vi.fn(async () => ({ content: "ran" }));
    const hooks = fakeHooks(async (event) => ({
      blocked: event === "PreToolUse",
      stdout: "",
    }));

    const result = await runAgent("run", { provider, tools: [], executeTool, hooks });

    expect(executeTool).not.toHaveBeenCalled();
    const toolMsg = result.messages.find((m) => m.role === "tool") as Message;
    expect(toolMsg.content).toBe("PERMISSION_DENIED: denied by PreToolUse hook");
  });

  it("does nothing at all when hooks are not configured", async () => {
    const { provider } = makeProvider([bashCallTurn, textTurn("ok")]);
    const permissions = new PermissionEngine(
      { rules: [{ tool: "run_bash", kind: "any", pattern: "", action: "allow", origin: "config" }] },
      "/workspace",
    );
    const executeTool = vi.fn(async () => ({ content: "ran" }));
    const sessionStore = fakeSessionStore();

    await runAgent("run", { provider, tools: [], executeTool, permissions, sessionStore: sessionStore as any, sessionId: "s1" });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(sessionStore.appendPermission).toHaveBeenCalledTimes(1);
  });
});
