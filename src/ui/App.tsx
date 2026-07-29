import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { dirname } from "node:path";
import { previewEdit } from "../permissions/diffpreview.js";
import type { AppContext, StatusSegment } from "./types.js";
import type { ModelEntry } from "./ModelSelector.js";

import OutputArea from "./OutputArea.js";
import Spinner from "./Spinner.js";
import PermissionPrompt from "./PermissionPrompt.js";
import ChatInput from "./ChatInput.js";
import StatusBar from "./StatusBar.js";
import ModelSelector from "./ModelSelector.js";
import { SILENT_TOOLS, describeToolCall, SPINNER_FRAMES } from "./ToolCallFormatter.js";

export default function App({ ctx }: { ctx: AppContext }) {
  const { exit } = useApp();
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [activeLine, setActiveLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [firstToken, setFirstToken] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [statusLine, setStatusLine] = useState<StatusSegment[]>([]);
  const [askPrompt, setAskPrompt] = useState<{
    resolve: (v: boolean) => void;
    toolName: string;
    args: Record<string, unknown>;
  } | null>(null);
  const [modelPicker, setModelPicker] = useState<{ entries: ModelEntry[] } | null>(null);

  // Mutable refs for streaming callbacks (avoid stale closures)
  const activeLineRef = useRef("");
  const firstTokenRef = useRef(false);
  const spinnerTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelled = useRef(false);

  // Output batching queue — streaming callbacks push lines here instead of
  // calling setOutputLines directly. A 50ms flush timer drains them into a
  // single setState call so React re-renders ~20 times/second instead of
  // per-character.
  const outputQueueRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track code block state across streaming pushes so multi-line ``` fences
  // arrive as a single block that MarkdownText can render.
  const codeBlockRef = useRef<{
    active: boolean;
    lines: string[];
  }>({ active: false, lines: [] });

  function setActiveLineBoth(v: string) {
    activeLineRef.current = v;
    setActiveLine(v);
  }

  function setFirstTokenBoth(v: boolean) {
    firstTokenRef.current = v;
    setFirstToken(v);
  }

  /** Drain the output queue into a single setOutputLines call. */
  function flushOutputQueue() {
    const batch = outputQueueRef.current;
    if (batch.length === 0) return;
    outputQueueRef.current = [];
    setOutputLines((prev) => [...prev, ...batch]);
  }

  function startFlushTimer() {
    stopFlushTimer();
    flushTimerRef.current = setInterval(flushOutputQueue, 50);
  }

  function stopFlushTimer() {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }

  function startSpinner() {
    stopSpinner();
    let frame = 0;
    setSpinnerFrame(0);
    spinnerTimer.current = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      setSpinnerFrame(frame);
    }, 80);
  }

  function stopSpinner() {
    if (spinnerTimer.current) {
      clearInterval(spinnerTimer.current);
      spinnerTimer.current = null;
    }
  }

  useEffect(() => {
    return () => {
      stopSpinner();
      stopFlushTimer();
      flushOutputQueue();
    };
  }, []);

  function pushOutput(line: string) {
    setOutputLines((prev) => [...prev, line]);
  }

  const runAgentTurn = useCallback(
    async (input: string) => {
      if (!input.trim()) return;

      const scheduleOutput = (line: string) => outputQueueRef.current.push(line);

      setActiveLineBoth("");
      setBusy(true);
      setFirstTokenBoth(false);
      startFlushTimer();
      startSpinner();
      cancelled.current = false;

      let textBuffer = "";

      const callbacks = {
        onText: (c: string) => {
          if (!firstTokenRef.current) {
            setFirstTokenBoth(true);
            setBusy(false);
            stopSpinner();
          }
          textBuffer += c;
          const rawLines = textBuffer.split("\n");
          for (let i = 0; i < rawLines.length - 1; i++) {
            const line = rawLines[i];

            // Group fenced code blocks into a single output entry
            if (line.startsWith("```")) {
              if (codeBlockRef.current.active) {
                codeBlockRef.current.lines.push(line);
                const block = codeBlockRef.current.lines.join("\n");
                codeBlockRef.current = { active: false, lines: [] };
                scheduleOutput(block);
              } else {
                codeBlockRef.current = { active: true, lines: [line] };
              }
              textBuffer = "";
              continue;
            }

            if (codeBlockRef.current.active) {
              codeBlockRef.current.lines.push(line);
              textBuffer = "";
              continue;
            }

            scheduleOutput(line);
          }
          textBuffer = rawLines[rawLines.length - 1];
          if (codeBlockRef.current.active) {
            const preview = codeBlockRef.current.lines.join("\n") + (textBuffer ? "\n" + textBuffer : "");
            setActiveLineBoth(preview);
          } else {
            setActiveLineBoth(textBuffer);
          }
        },
        onToolStart: (name: string, args: Record<string, unknown>) => {
          if (activeLineRef.current) scheduleOutput(activeLineRef.current);
          setActiveLineBoth("");
          if (SILENT_TOOLS.has(name)) {
            textBuffer = "";
            return;
          }
          const desc = describeToolCall(name, args);
          const dim = ctx.getColorEnabled() ? "\x1b[2m" : "";
          const reset = ctx.getColorEnabled() ? "\x1b[0m" : "";
          scheduleOutput(`${dim}  ${desc}${reset}`);
          textBuffer = "";
        },
        onToolResult: (_name: string, result: { content: string; error?: string }) => {
          if (result.content?.startsWith("PERMISSION_DENIED")) {
            scheduleOutput("  Permission denied");
          } else if (result.content?.startsWith("COMMAND_FAILED")) {
            scheduleOutput(`  Command failed: ${result.content.slice(16)}`);
          }
        },
        onDiagnostic: () => {},
        onRetry: () => {},
        onCompacted: () => {},
        onLoopDetected: (m: string) => { scheduleOutput(`[${m}]`); },
        onMaxTurns: () => { scheduleOutput("[max turns reached. Session saved.]"); },
        onUsage: () => { setStatusLine(ctx.buildStatusBar()); },
        onNewMessages: async (userInput: string, newMessages: any[]) => {
          await ctx.sessionStore.appendMessage(ctx.sessionId, { role: "user", content: userInput });
          for (const msg of newMessages) {
            if (msg.role !== "system") {
              await ctx.sessionStore.appendMessage(ctx.sessionId, msg);
            }
          }
        },
        onHistoryUpdate: (messages: any[]) => {
          ctx.mutable.conversationHistory = messages;
        },
        askUser: async (toolName: string, args: Record<string, unknown>) => {
          if (["edit", "edit_file", "write_to_file", "write", "search_replace", "apply_diff", "apply_patch"].includes(toolName)) {
            const preview = previewEdit(toolName, args);
            if (preview) scheduleOutput(preview);
          }
          return new Promise<boolean>((resolve) => {
            setAskPrompt({ resolve, toolName, args });
          });
        },
      };

      try {
        const result = await ctx.runAgentTurnCore(input, callbacks);

        // Drain queued output before final items so order is preserved
        flushOutputQueue();

        if (codeBlockRef.current.active && codeBlockRef.current.lines.length > 0) {
          pushOutput(codeBlockRef.current.lines.join("\n"));
          codeBlockRef.current = { active: false, lines: [] };
        }
        if (activeLineRef.current) pushOutput(activeLineRef.current);
        setActiveLineBoth("");
        textBuffer = "";

        if (result.stopReason === "done") {
          ctx.mutable.conversationHistory = result.messages;
          await callbacks.onNewMessages(input, result.newMessages);
        }
      } catch (err) {
        flushOutputQueue();
        pushOutput(`Error: ${(err as Error).message}`);
      } finally {
        stopFlushTimer();
        setBusy(false);
        stopSpinner();
        codeBlockRef.current = { active: false, lines: [] };
        ctx.renewAbortController();
        setStatusLine(ctx.buildStatusBar());
      }
    },
    [ctx],
  );

  function handleSlashCommand(trimmed: string) {
    if (trimmed === "/exit") {
      ctx.logSessionEnd().finally(() => exit());
      return;
    }
    if (trimmed === "/model") {
      setModelPicker({ entries: ctx.getModelEntries() });
      return;
    }
    ctx.handleSlash(trimmed).then((lines) => {
      for (const line of lines) pushOutput(line);
      setStatusLine(ctx.buildStatusBar());
    });
  }

  // ── Global key handler (modal, admin, and abort keys only) ──
  useInput((value: string, key: any) => {
    if (modelPicker) return;

    // Permission prompt handling
    if (askPrompt) {
      const lower = value.toLowerCase();
      const enterPressed = key.return;
      if (enterPressed || lower === "y" || lower === "n" || lower === "a") {
        const resolve = askPrompt.resolve;
        const toolName = askPrompt.toolName;
        const args = askPrompt.args;

        const isAlways = lower === "a";
        const isDeny = lower === "n";

        if (isAlways) {
          let pattern = "*";
          if (toolName === "run_bash" && typeof (args as any).command === "string") {
            pattern = (args as any).command.split(/\s+/)[0] + " *";
          } else if (typeof (args as any).filePath === "string") {
            const dir = dirname((args as any).filePath);
            pattern = dir !== "." && dir !== "/" ? dir + "/*" : "*";
          } else if (typeof (args as any).path === "string") {
            const dir = dirname((args as any).path);
            pattern = dir !== "." && dir !== "/" ? dir + "/*" : "*";
          }
          ctx.permissions.addSessionRule({ tool: toolName, pattern, action: "allow" });
        }

        setAskPrompt(null);
        resolve(enterPressed ? true : !isDeny);
        setBusy(true);
        startSpinner();
      }
      return;
    }

    // Abort while busy
    if (busy) {
      if (key.escape || (key.ctrl && key.name === "c")) {
        ctx.provideAbortController().abort();
      }
      return;
    }

    // Ctrl-C when not busy: abort + clear input (handled by ChatInput's useInput for the clear)
    if (key.ctrl && key.name === "c" && !value) {
      ctx.provideAbortController().abort();
      ctx.renewAbortController();
      return;
    }

    // Cycle approval mode
    if (key.shiftTab || ((key.ctrl || key.meta) && key.name === "tab")) {
      ctx.cycleApprovalMode();
      setStatusLine(ctx.buildStatusBar());
      return;
    }
  });

  const promptStr = ctx.getPromptStr();
  const colorEnabled = ctx.getColorEnabled();

  return (
    <Box flexDirection="column">
      <OutputArea lines={outputLines} activeLine={activeLine} busy={busy} />

      <Spinner busy={busy} firstToken={firstToken} frame={spinnerFrame} />

      {askPrompt && (
        <PermissionPrompt
          toolName={askPrompt.toolName}
          args={askPrompt.args}
          colorEnabled={colorEnabled}
        />
      )}

      {modelPicker && (
        <ModelSelector
          entries={modelPicker.entries}
          onSelect={async (entry) => {
            setModelPicker(null);
            if (entry) {
              const lines = await ctx.handleSlash(`/model ${entry.provider}/${entry.model}`);
              for (const line of lines) pushOutput(line);
              setStatusLine(ctx.buildStatusBar());
            }
          }}
          currentProvider={ctx.providerName}
          currentModel={ctx.activeModel ?? ""}
          colorEnabled={colorEnabled}
        />
      )}

      {!busy && !askPrompt && !modelPicker && (
        <ChatInput
          promptStr={promptStr}
          busy={busy}
          onSubmit={(text) => {
            if (text.startsWith("/")) {
              handleSlashCommand(text);
            } else {
              runAgentTurn(text);
            }
          }}
          onCompletions={(lines) => pushOutput(lines.join("  "))}
          completer={ctx.completer}
          onModelPickerOpen={() => setModelPicker({ entries: ctx.getModelEntries() })}
        />
      )}

      <StatusBar segments={statusLine} />
    </Box>
  );
}
