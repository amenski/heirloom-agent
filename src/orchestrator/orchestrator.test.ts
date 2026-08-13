import { describe, it, expect, vi, afterEach } from "vitest";
import { Orchestrator } from "./index.js";
import { ToolRegistry } from "../tools/registry.js";
import { ModeLoader } from "../modes/loader.js";
import { PermissionEngine } from "../permissions/index.js";
import { executeTool as realExecuteTool, registry as realRegistry, setTodoStore } from "../tools/index.js";
import { todoStore } from "../tools/todo.js";
import type { Provider, StreamEvent } from "../providers/types.js";
import type { Message, ToolDef } from "../types.js";
import type { ToolContext } from "../tools/types.js";

type TurnScript = StreamEvent[];

function makeProvider(turns: TurnScript[]) {
  const received: { messages: Message[]; tools: ToolDef[] }[] = [];
  let call = 0;
  const provider: Provider = {
    name: "fake",
    async *streamChat(messages, tools) {
      received.push({ messages: [...messages], tools: tools ? [...tools] : [] });
      const events = turns[call] ?? [];
      call++;
      for (const event of events) yield event;
    },
  };
  return { provider, received };
}

const textTurn = (text: string): TurnScript => [
  { type: "text_delta", content: text },
  { type: "done", finishReason: "stop" },
];

const toolCallTurn = (id: string, name: string, args: string): TurnScript => [
  { type: "tool_call_start", id, name },
  { type: "tool_call_delta", id, arguments: args },
  { type: "done", finishReason: "tool_calls" },
];

const ctx: ToolContext = {
  workingDir: "/workspace",
  sessionId: "test-session",
  signal: new AbortController().signal,
  fileMtimes: new Map(),
};

/** Minimal registry with one read-group and one command-group tool. */
function makeRegistry(): { registry: ToolRegistry; runBash: ReturnType<typeof vi.fn> } {
  const registry = new ToolRegistry();
  const runBash = vi.fn(async (args: Record<string, unknown>) => ({ content: `ran ${String(args.command)}` }));
  registry.register({
    def: { name: "read_file", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    handler: async (args) => ({ content: `content of ${String(args.path)}` }),
    groups: ["read"],
  });
  registry.register({
    def: { name: "run_bash", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    handler: runBash,
    groups: ["command"],
  });
  return { registry, runBash };
}

describe("Orchestrator", () => {
  // The module-level tool context pointer is swapped during sub-runs; restore
  // it and the singleton so no state leaks between tests in this file.
  afterEach(() => {
    setTodoStore(todoStore);
    todoStore.reset();
  });
  it("registers new_task in the workflow group and spawns a sub-agent in the requested mode with that mode's tools", async () => {
    const { registry } = makeRegistry();
    const { provider, received } = makeProvider([
      toolCallTurn("c1", "read_file", '{"path":"a.txt"}'),
      textTurn("sub-agent done"),
    ]);
    const orchestrator = new Orchestrator({
      provider: () => provider,
      registry,
      executeTool: async (call) => registry.execute(call, ctx),
      modeLoader: new ModeLoader(),
    });
    orchestrator.register(registry);

    // The workflow group (orchestrator mode) exposes new_task…
    expect(registry.getByMode(["workflow"]).map((d) => d.name)).toEqual(["new_task"]);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "read the file", mode: "code" } },
      ctx,
    );

    expect(out.error).toBeUndefined();
    expect(out.content).toContain("**Task**: read the file");
    expect(out.content).toContain("**Tools executed**: 1");
    expect(out.content).toContain("**Result**: sub-agent done");

    // The sub-agent ran with code mode's tool groups (read/edit/command) plus
    // new_task for nested delegation, and its system prompt carries the code
    // role definition — mode is threaded through to the sub-run.
    const subTools = received[0].tools.map((t) => t.name);
    expect(subTools).toEqual(expect.arrayContaining(["read_file", "run_bash", "new_task"]));
    expect(String(received[0].messages[0].content)).toContain("senior software engineer");
  });

  it("re-points the askUser bridge via setAskUser (the interactive per-turn re-wire)", async () => {
    const { registry } = makeRegistry();
    const { provider } = makeProvider([
      toolCallTurn("c1", "run_bash", '{"command":"npm test"}'),
      textTurn("approved path done"),
    ]);
    const permissions = new PermissionEngine(undefined, "/workspace");
    const staleAsk = vi.fn(async () => true);
    const currentAsk = vi.fn(async () => true);

    const orchestrator = new Orchestrator({
      provider: () => provider,
      registry,
      executeTool: async (call) => registry.execute(call, ctx),
      modeLoader: new ModeLoader(),
      permissions,
      askUser: staleAsk,
    });
    // cli.tsx's runAgentTurnCore calls setAskUser with the fresh per-turn bridge.
    orchestrator.setAskUser(currentAsk);
    orchestrator.register(registry);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "run tests", mode: "code" } },
      ctx,
    );

    // The sub-agent's ask-tier run_bash surfaced to the CURRENT bridge, not the
    // stale one captured at registration.
    expect(currentAsk).toHaveBeenCalledWith("run_bash", { command: "npm test" });
    expect(staleAsk).not.toHaveBeenCalled();
    expect(out.error).toBeUndefined();
  });

  it("auto-denies ask-tier calls headlessly when no askUser is set", async () => {
    const { registry, runBash } = makeRegistry();
    const { provider } = makeProvider([
      toolCallTurn("c1", "run_bash", '{"command":"npm test"}'),
      textTurn("headless done"),
    ]);
    const permissions = new PermissionEngine(undefined, "/workspace");

    const orchestrator = new Orchestrator({
      provider: () => provider,
      registry,
      executeTool: async (call) => registry.execute(call, ctx),
      modeLoader: new ModeLoader(),
      permissions,
    });
    orchestrator.register(registry);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "run tests", mode: "code" } },
      ctx,
    );

    expect(out.error).toBeUndefined();
    expect(runBash).not.toHaveBeenCalled();
  });

  it("gives the sub-agent its own todo store: parent checklist untouched, sub context sees its own plan", async () => {
    // Uses the REAL module-level registry/executeTool (what production wires),
    // so the setTodoStore swap during the sub-run is exercised end-to-end.
    const { provider: subProvider, received } = makeProvider([
      toolCallTurn("c1", "update_todo_list", JSON.stringify({
        todos: [
          { content: "Sub step A", status: "pending" },
          { content: "Sub step B", status: "in_progress" },
        ],
      })),
      textTurn("sub done"),
    ]);
    const orchestrator = new Orchestrator({
      provider: () => subProvider,
      registry: realRegistry,
      executeTool: realExecuteTool,
      modeLoader: new ModeLoader(),
    });
    orchestrator.register(realRegistry);

    const out = await realRegistry.execute(
      { id: "t1", name: "new_task", arguments: { description: "sub plan", mode: "code" } },
      { workingDir: "/workspace", sessionId: "test", signal: new AbortController().signal },
    );

    expect(out.error).toBeUndefined();
    expect(out.content).toContain("**Result**: sub done");

    // The sub-agent's update_todo_list wrote to ITS store — the singleton the
    // parent panel subscribes to was never touched.
    expect(todoStore.getTodos()).toEqual([]);

    // The sub-agent's own context got its plan injected on the follow-up turn.
    expect(JSON.stringify(received[0].messages)).not.toContain("# Current todo list");
    expect(JSON.stringify(received[1].messages)).toContain("# Current todo list");
    expect(JSON.stringify(received[1].messages)).toContain("- [pending] Sub step A");
    expect(JSON.stringify(received[1].messages)).toContain("- [in_progress] Sub step B");

    // The module context was restored: a parent-side update after the sub-run
    // lands in the singleton again.
    await realExecuteTool({
      id: "t2",
      name: "update_todo_list",
      arguments: { todos: [{ content: "parent step", status: "pending" }] },
    });
    expect(todoStore.getTodos()).toEqual([{ content: "parent step", status: "pending" }]);
  });

  it("caps nesting at maxDepth and never spawns beyond it", async () => {
    const { registry } = makeRegistry();
    const newTaskCall = (description: string) =>
      toolCallTurn("c1", "new_task", JSON.stringify({ description, mode: "code" }));
    const providerFactory = vi.fn(() => {
      const depth = providerFactory.mock.calls.length - 1;
      return makeProvider([
        newTaskCall(`level ${depth + 1}`),
        textTurn(`level ${depth} done`),
      ]).provider;
    });

    const orchestrator = new Orchestrator({
      provider: providerFactory,
      registry,
      executeTool: async (call) => registry.execute(call, ctx),
      modeLoader: new ModeLoader(),
    });
    orchestrator.register(registry);

    const out = await registry.execute(
      { id: "t1", name: "new_task", arguments: { description: "level 0", mode: "code" } },
      ctx,
    );

    // depth 0, 1, 2 spawn sub-agents; the depth-3 request returns MAX_DEPTH
    // without a fourth provider call.
    expect(out.error).toBeUndefined();
    expect(providerFactory).toHaveBeenCalledTimes(3);
    expect(out.content).toContain("**Result**: level 0 done");
  });
});
