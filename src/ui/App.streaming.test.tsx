import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import App from "./App.js";
import type { AppContext } from "./types.js";
import { __resetInputWireForTests } from "./hooks/useTerminalInput.js";
import { stripAnsi } from "./test-helpers.js";
import { todoStore } from "../tools/todo.js";

// ── Test doubles ──
//
// history-store writes to ~/.heirloom; App's promptHistory initializer calls it
// at mount. Point it at a throwaway temp dir so App-level tests never touch the
// developer's real prompt history. Accessibility announcements early-return
// without a TTY, so they are safe to leave live.
vi.mock("./core/history-store.js", () => ({
  loadPromptHistory: () => [],
  appendPromptHistory: () => Promise.resolve(),
  HISTORY_CAP: 1000,
}));

// A /raw toggle writes to process.stdout when raw mode is on — App defaults to
// normal mode and these tests never switch it, but stub stdout to keep any
// stray write out of the test runner's output.
const { fakeStdout } = await import("./test-helpers.js");
// A /raw toggle writes to process.stdout when raw mode is on — App defaults to
// normal mode and these tests never switch it, but keep a fake TTY stream
// around (the same helper incremental-render.test.tsx uses) so any stray write
// has a sink instead of reaching the test runner's output.
const { writes, stream } = fakeStdout();

// ── Fake AppContext ──

function makeCtx(
  runAgentTurnCore: AppContext["runAgentTurnCore"],
): AppContext {
  return {
    mutable: {
      conversationHistory: [],
      sessionInput: 0,
      sessionOutput: 0,
      lastContextTokens: 0,
      sessionUserInputs: [],
    },
    getProvider: () => ({}) as any,
    sessionId: "test-session",
    activeMode: null,
    permissions: {
      resolve: () => ({ action: "allow", winningRule: null, wasUnresolved: false, isGuarded: false }),
      buildDefaultRule: () => null,
      folderScopeRule: () => null,
      approveForSession: () => {},
      approveAlways: () => {},
    } as any,
    toolRegistry: null,
    compactor: null,
    diagnostics: null,
    skills: [],
    memoryInjection: undefined,
    memoryStore: null,
    sessionStore: {
      appendMessage: () => Promise.resolve(),
      appendPermission: () => Promise.resolve(),
    },
    checkpoints: { list: () => Promise.resolve([]) },
    modeLoader: null,
    skillLoader: null,
    providerName: "test",
    activeModel: "test-model",
    effortValues: () => [],
    provideAbortController: () => new AbortController(),
    renewAbortController: () => {},
    completer: () => [[], ""],
    buildStatusBar: () => [],
    getPromptStr: () => "❯",
    getColorEnabled: () => false,
    logSessionEnd: async () => null,
    onExit: () => {},
    handleSlash: async () => [],
    getModelEntries: () => [],
    runAgentTurnCore,
    theme: undefined,
    keybindings: undefined,
    keybindingConfig: undefined,
    workflowConfig: undefined,
    gitStatus: null,
  } as any as AppContext;
}

const flush = () => new Promise((r) => setTimeout(r, 60));

// useTerminalInput keeps ONE module-level stdin listener for the process, so a
// component left mounted from a previous test keeps ownership of the wire and
// the next render's keys go nowhere. Unmount and reset between tests.
const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

/**
 * Drive a full agent turn through App: render it, type a prompt, press Enter,
 * and let the fake provider stream its response through the same onText/
 * onToolStart/onToolResult callbacks the real bridge uses.
 */
async function runTurn(
  prompt: string,
  chunks: string[],
): Promise<{ lastFrame: () => string | undefined; inst: ReturnType<typeof render> }> {
  let callbacks: any = null;
  const ctx = makeCtx(async (_input: string, cb: any) => {
    callbacks = cb;
    for (const c of chunks) cb.onText(c);
    cb.onToolStart("run_bash", { command: "echo hi" });
    cb.onToolResult("run_bash", { content: "hi" });
    cb.onToolStart("run_bash", { command: "echo bye" });
    cb.onToolResult("run_bash", { content: "bye" });
    return {
      stopReason: "done",
      messages: [],
      newMessages: [],
    };
  });

  const inst = render(<App ctx={ctx} />);
  mounted.push(inst);
  inst.stdin.write(prompt);
  await flush();
  inst.stdin.write("\r");
  await flush();
  // Give the streamed state a beat to flush through React.
  await flush();
  await flush();
  return { lastFrame: () => inst.lastFrame(), inst };
}

describe("todo panel", () => {
  afterEach(() => todoStore.reset());

  it("renders the agent's live checklist, suppresses the redundant result echo, and clears at the next turn", async () => {
    todoStore.reset();
    const ctx = makeCtx(async (_input: string, cb: any) => {
      // The model's first update_todo_list call: the ⏺ header fires, then the
      // real handler writes the store (simulated here), then the tool result
      // returns the full list.
      cb.onToolStart("update_todo_list", { todos: [] });
      todoStore.setTodos([
        { content: "Add F feedrate capture", status: "pending" },
        { content: "Per-segment time math", status: "in_progress" },
        { content: "UI row in the pro gate", status: "completed" },
      ]);
      cb.onToolResult("update_todo_list", {
        content: "Todo list updated (3 items):\n# Current todo list\n- [pending] Add F feedrate capture",
      });
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("build it");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();

    // The turn is over by now; the panel persists (dimmed) with all three
    // statuses rendered as the checklist glyphs.
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame).toContain("◻ Add F feedrate capture");
    expect(frame).toContain("▸ Per-segment time math");
    expect(frame).toContain("☑ UI row in the pro gate");
    // The call header stays (visible marker), but the redundant result echo —
    // which would print the whole list dimmed — is suppressed.
    expect(frame).toContain("⏺ update_todo_list");
    expect(frame).not.toContain("Todo list updated");

    // A check-off mid-turn re-renders the panel live.
    todoStore.setTodos([
      { content: "Add F feedrate capture", status: "completed" },
      { content: "Per-segment time math", status: "in_progress" },
    ]);
    await flush();
    await flush();
    const frame2 = stripAnsi(inst.lastFrame() ?? "");
    expect(frame2).toContain("☑ Add F feedrate capture");
    expect(frame2).not.toContain("◻ Add F feedrate capture");
  });
});

describe("App streaming markdown", () => {
  it("merges a span split across streamed lines into bold", async () => {
    const { lastFrame } = await runTurn("hi", ["**bold\n", "continues**"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("bold");
    expect(frame).toContain("continues");
    expect(frame).not.toContain("**");
    // The held paragraph commits exactly ONCE at the tool-start flush — the
    // stale active-line preview must not be scheduled a second time. (This
    // regressed during the stream-blocks refactor: the preview used to hold
    // only the partial tail, but now includes the held paragraph, which
    // flushStream already committed.)
    expect(frame.match(/bold/g) ?? []).toHaveLength(1);
    expect(frame.match(/continues/g) ?? []).toHaveLength(1);
  });

  it("keeps a wrapped list item under one bullet", async () => {
    const { lastFrame } = await runTurn("hi", ["- item one\n", "  wrapped\n", "plain\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("item one");
    expect(frame).toContain("wrapped");
    expect(frame).toContain("plain");
    const bullets = frame.split("\n").filter((l) => l.includes("•")).length;
    // "item one" and its wrapped continuation share one bullet; "plain" is a
    // plain line.
    expect(bullets).toBe(1);
  });

  it("keeps a multi-line blockquote as one block", async () => {
    const { lastFrame } = await runTurn("hi", ["> line one\n", "> line two\n", "plain\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    expect(frame).toContain("plain");
    // Both quote lines carry the ▎ marker and the raw ">" never leaks; the
    // following "plain" line is a separate paragraph, not a lazy continuation.
    expect(frame.split("\n").filter((l) => l.includes("▎")).length).toBe(2);
    expect(frame).not.toContain("> line");
  });

  it("commits an unclosed fence as a code block at turn end", async () => {
    const { lastFrame } = await runTurn("hi", ["```ts\n", "const x = 1;\n", "```\n"]);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("const x = 1;");
    expect(frame).not.toContain("```");
  });

  it("does not duplicate a partial tail committed at turn end", async () => {
    // No trailing newline and no tool call: the partial line is committed by
    // the turn-end flushStream, and the stale active-line preview must not be
    // pushed a second time by the `if (activeLineRef.current)` fallback.
    let callbacks: any = null;
    const ctx = makeCtx(async (_input: string, cb: any) => {
      callbacks = cb;
      cb.onText("partial tail");
      return { stopReason: "done", messages: [], newMessages: [] };
    });
    const inst = render(<App ctx={ctx} />);
    mounted.push(inst);
    inst.stdin.write("hi");
    await flush();
    inst.stdin.write("\r");
    await flush();
    await flush();
    await flush();
    const frame = stripAnsi(inst.lastFrame() ?? "");
    expect(frame.match(/partial tail/g) ?? []).toHaveLength(1);
    expect(callbacks).not.toBeNull();
  });
});
