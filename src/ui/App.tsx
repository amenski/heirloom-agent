import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { Box, Text, useInput, useApp } from "ink";
import { previewEdit } from "../permissions/diffpreview.js";
import type { AppContext, StatusSegment, GitStatus } from "./types.js";
import type { PermissionRule } from "../permissions/index.js";
import type { KeybindingConfig } from "./keybindings.js";

import {
  ThemeProvider,
  type ThemeProviderOptions,
  useTheme,
  useThemeController,
  KeybindingProvider,
  useKeybindings,
  TerminalProvider,
  useTerminalInfo,
  AccessibilityProvider,
  useAccessibility,
  RawModeProvider,
  useRawMode,
} from "./contexts.js";
import ErrorBoundary from "./ErrorBoundary.js";
import HelpOverlay from "./HelpOverlay.js";
import CommandPalette, {
  type CommandPaletteAction,
} from "./CommandPalette.js";

import OutputArea from "./OutputArea.js";
import Spinner from "./Spinner.js";
import StatusBar from "./StatusBar.js";
import PermissionPrompt, { DestructiveConfirmPrompt, type PermissionDecision } from "./PermissionPrompt.js";
import WelcomeScreen from "./views/WelcomeScreen.js";
import PromptInput from "./views/PromptInput.js";
import AskUserQuestionPrompt from "./views/AskUserQuestionPrompt.js";
import PlanImplementationPrompt from "./views/PlanImplementationPrompt.js";
import SessionList from "./views/SessionList.js";
import UndoSelector from "./views/UndoSelector.js";
import McpStatusList from "./views/McpStatusList.js";
import PermissionHistoryList from "./views/PermissionHistoryList.js";
import ResumeChooser from "./views/ResumeChooser.js";
import { buildReplayLines } from "./core/replay.js";
import type { Message } from "../types.js";
import type { AskQuestionItem } from "../tools/types.js";
import { setAskQuestion } from "../tools/index.js";
import { ModelsDropdown } from "./components/index.js";
import ThemeDropdown, { persistThemeChoice } from "./components/ThemeDropdown/index.js";
import { USER_ECHO_TAG, COMMAND_ECHO_TAG } from "./constants.js";
import {
  SPINNER_FRAMES,
  formatToolCallHeader,
  formatToolResultPreview,
} from "./ToolCallFormatter.js";
import {
  lookupAction,
} from "./keybindings.js";
import { announceToScreenReader } from "./Accessibility.js";
import { buildExitSummaryText, buildResumeHintText } from "./exit-summary.js";

// Display label for a queued item in the above-input stack. A large paste is
// collapsed to a bracket summary ("[Pasted N lines]") rather than dumping the
// whole block into the stack; short messages are shown inline (newlines
// flattened). The stored queue text is unchanged — this is display only.
function queuedLabel(text: string): string {
  const lineCount = text.split("\n").length;
  if (lineCount >= 4 || text.length > 240) {
    return `[Pasted ${lineCount} line${lineCount === 1 ? "" : "s"}]`;
  }
  return text.replace(/\n/g, " ");
}

// The "time capsule" shown in front of a queued line: the local wall-clock time
// (HH:MM) the item was queued, e.g. "[19:24]".
function formatQueueTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[${hh}:${mm}]`;
}

function InnerApp({ ctx }: { ctx: AppContext }) {
  const { exit } = useApp();
  const theme = useTheme();
  const themeController = useThemeController();
  const accessibility = useAccessibility();
  const bindings = useKeybindings();
  const rawMode = useRawMode();

  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [activeLine, setActiveLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  // A turn-scoped "working" indicator, distinct from `busy` (which flips false at
  // the first streamed token so the input unlocks mid-turn). `turnActive` stays
  // true for the whole turn — including the silent stretches during tool calls
  // and follow-up model turns — so progress is always visible while working.
  const [turnActive, setTurnActive] = useState(false);
  const [turnElapsed, setTurnElapsed] = useState(0);
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [statusLine, setStatusLine] = useState<StatusSegment[]>(() =>
    ctx.buildStatusBar(),
  );
  // Segments from config-driven statusline providers (command/module). These
  // refresh asynchronously outside render; the manager pushes fresh segments
  // here via its listener. Appended after the built-in segments in StatusBar.
  const [statusLineProviderSegments, setStatusLineProviderSegments] = useState<
    StatusSegment[]
  >(() => ctx.statusLineManager?.segments ?? []);
  const [askPrompt, setAskPrompt] = useState<{
    resolve: (v: boolean) => void;
    toolName: string;
    args: Record<string, unknown>;
    winningRule?: PermissionRule;
    cursor: number;
  } | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showThemeDropdown, setShowThemeDropdown] = useState(false);
  // The theme name active when the /theme picker opened — the revert target if
  // the user presses Esc after live-previewing other themes.
  const themeBeforePreviewRef = useRef<string>("dark");
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [reasoningEffort, setReasoningEffort] = useState<"high" | "max" | undefined>(undefined);
  const [askQuestionPrompt, setAskQuestionPrompt] = useState<{
    questions: AskQuestionItem[];
    resolve: (answers: Record<string, string> | null) => void;
  } | null>(null);

  // Permission/execution posture, cycled by Shift+Tab: normal → autoApprove → plan.
  // - normal: permissions ask per policy.
  // - autoApprove: non-denied tool calls run without prompting.
  // - plan: model proposes a <proposed_plan> instead of executing.
  type Posture = "normal" | "autoApprove" | "plan";
  const [posture, setPosture] = useState<Posture>("normal");
  const planMode = posture === "plan";
  const [planPrompt, setPlanPrompt] = useState<{
    planText: string;
    followUpPrompt: string;
  } | null>(null);
  const [showSessionList, setShowSessionList] = useState(false);
  const [showUndoSelector, setShowUndoSelector] = useState(false);
  const [showMcpStatus, setShowMcpStatus] = useState(false);
  const [showPermissionHistory, setShowPermissionHistory] = useState(false);
  // Startup resume chooser: null until a resumed session offers the load/compact
  // choice, then holds the message count for the prompt. Set in the mount effect.
  const [resumeChoice, setResumeChoice] = useState<{ count: number } | null>(null);
  const [compactingResume, setCompactingResume] = useState(false);
  const [promptDraft, setPromptDraft] = useState<{ nonce: number; text: string } | null>(null);
  const draftNonceRef = useRef(0);

  const [showHelp, setShowHelp] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const [sessionStart] = useState(() => Date.now());
  const [tokenCounts, setTokenCounts] = useState<{
    input: number;
    output: number;
  } | null>(null);

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);

  // Queue of user submissions (messages or slash commands) entered while a turn
  // is in flight. Drained FIFO, one turn at a time, when the active turn ends.
  // `at` is the wall-clock time the item was queued (ms epoch), shown as a
  // "time capsule" in front of each stacked line.
  type QueuedItem =
    | { kind: "message"; text: string; at: number; imageUrls?: string[] }
    | { kind: "slash"; text: string; at: number };
  const messageQueueRef = useRef<QueuedItem[]>([]);
  // Text + queue time of each item in arrival order, shown stacked above the input.
  const [queuedItems, setQueuedItems] = useState<Array<{ text: string; at: number }>>([]);
  // Mirror the queue's current contents into render state; called from every
  // enqueue/drain site so the stack stays in sync.
  const syncQueueState = () => {
    setQueuedItems(messageQueueRef.current.map((q) => ({ text: q.text, at: q.at })));
  };
  // Mirrors "any modal footer view is open" for the queue drain, which runs
  // outside React's render cycle and can't read the latest state directly.
  const modalOpenRef = useRef(false);
  // True from the moment a turn starts until its `finally` runs. Distinct from
  // `busy` (the UI flag), which flips false on the first streamed token so the
  // input becomes interactive mid-turn — the queue must drain on real turn
  // completion, not on that first-token signal.
  const turnActiveRef = useRef(false);

  useEffect(() => {
    if (ctx.showResumeOnStart) {
      setShowSessionList(true);
      ctx.showResumeOnStart = false;
    }
    if (ctx.initialNotice) {
      setOutputLines((prev) => [...prev, theme.colorEnabled ? `\x1b[2m${ctx.initialNotice}\x1b[0m` : ctx.initialNotice!]);
    }
    // A resumed session with prior turns offers a load/compact choice before its
    // transcript is replayed into the scrollback. The chooser handlers do the
    // actual replay (see handleResumeLoad / handleResumeCompact).
    if (ctx.initialMessages && ctx.initialMessages.length > 0) {
      setResumeChoice({ count: ctx.initialMessages.length });
    }
  }, []);

  // Config-driven statusline providers: subscribe and run the async refresh
  // loop. Segments are pushed in from outside render; the loop never blocks or
  // crashes the render (each provider is isolated in the manager).
  useEffect(() => {
    const mgr = ctx.statusLineManager;
    if (!mgr) return;
    mgr.onUpdate(setStatusLineProviderSegments);
    mgr.start();
    return () => mgr.stop();
  }, []);

  useEffect(() => {
    // Gate + interval come from config (workflow.gitStatus / gitPollInterval).
    const wf = ctx.workflowConfig;
    if (wf && wf.gitStatus === false) {
      setGitStatus(null);
      return;
    }
    const pollInterval = wf?.gitPollInterval ?? 30000;
    let cancelled = false;
    async function refreshGit() {
      try {
        const { execSync } = await import("node:child_process");
        const branch = execSync(
          "git rev-parse --abbrev-ref HEAD 2>/dev/null",
          { encoding: "utf-8", timeout: 3000 },
        ).trim();
        if (!branch || cancelled) {
          if (!branch) setGitStatus(null);
          return;
        }
        const status = execSync(
          "git status --porcelain=v1 2>/dev/null",
          { encoding: "utf-8", timeout: 3000 },
        ).trim();
        const aheadBehind = execSync(
          "git rev-list --count --left-right HEAD...@{upstream} 2>/dev/null",
          { encoding: "utf-8", timeout: 3000 },
        ).trim();

        const modified = status
          ? status.split("\n").filter((l) => l.startsWith(" M") || l.startsWith("M ")).length
          : 0;
        const added = status
          ? status.split("\n").filter((l) => l.startsWith("??")).length
          : 0;
        const deleted = status
          ? status.split("\n").filter((l) => l.startsWith(" D") || l.startsWith("D ")).length
          : 0;
        let ahead = 0;
        let behind = 0;
        if (aheadBehind) {
          const parts = aheadBehind.split("\t");
          if (parts.length >= 2) {
            ahead = parseInt(parts[0], 10) || 0;
            behind = parseInt(parts[1], 10) || 0;
          }
        }

        if (!cancelled) {
          setGitStatus({
            branch,
            ahead,
            behind,
            modified,
            added,
            deleted,
            staged: 0,
            conflicts: 0,
            dirty: modified > 0 || added > 0 || deleted > 0,
          });
        }
      } catch {
        if (!cancelled) setGitStatus(null);
      }
    }
    refreshGit();
    // gitPollInterval of 0 = on-demand only: run once, no recurring poll.
    if (pollInterval <= 0) {
      return () => {
        cancelled = true;
      };
    }
    const interval = setInterval(refreshGit, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [ctx.workflowConfig]);

  const activeLineRef = useRef("");
  const firstTokenRef = useRef(false);
  const spinnerTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelled = useRef(false);

  const outputQueueRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const codeBlockRef = useRef<{
    active: boolean;
    lines: string[];
  }>({ active: false, lines: [] });

  const reasoningRef = useRef<{ buffer: string; flushed: boolean }>({ buffer: "", flushed: false });

  function setActiveLineBoth(v: string) {
    activeLineRef.current = v;
    setActiveLine(v);
  }

  function setFirstTokenBoth(v: boolean) {
    firstTokenRef.current = v;
  }

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

  // Turn-scoped elapsed clock driving the "working" indicator. Ticks once a
  // second from turn start until the turn's `finally`.
  function startElapsedTimer() {
    stopElapsedTimer();
    setTurnElapsed(0);
    const started = Date.now();
    elapsedTimer.current = setInterval(() => {
      setTurnElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer.current) {
      clearInterval(elapsedTimer.current);
      elapsedTimer.current = null;
    }
  }

  useEffect(() => {
    return () => {
      stopSpinner();
      stopElapsedTimer();
      stopFlushTimer();
      flushOutputQueue();
    };
  }, []);

  function pushOutput(line: string) {
    if (rawMode.mode === "raw") {
      process.stdout.write(line + "\n");
    } else {
      setOutputLines((prev) => [...prev, line]);
    }
  }

  // Batched append — one state update for many lines (used by resume replay so a
  // long transcript doesn't trigger a re-render per line).
  function pushOutputLines(lines: string[]) {
    if (lines.length === 0) return;
    if (rawMode.mode === "raw") {
      for (const l of lines) process.stdout.write(l + "\n");
    } else {
      setOutputLines((prev) => [...prev, ...lines]);
    }
  }

  // Resume chooser handlers. "Load" replays the raw transcript; "Compact" runs
  // the summarizer (persisted as a non-destructive overlay by the host), then
  // replays the shorter result. Both close the chooser and drop the "N messages"
  // notice, which the replay supersedes.
  const replayResumed = useCallback((messages: Message[]) => {
    const lines = buildReplayLines(messages, theme.colorEnabled);
    pushOutputLines(lines);
    setResumeChoice(null);
  }, [theme.colorEnabled]);

  const handleResumeLoad = useCallback(() => {
    replayResumed(ctx.initialMessages ?? []);
  }, [ctx.initialMessages, replayResumed]);

  const handleResumeCompact = useCallback(async () => {
    if (!ctx.compactResumed) {
      replayResumed(ctx.initialMessages ?? []);
      return;
    }
    setCompactingResume(true);
    try {
      const compacted = await ctx.compactResumed();
      replayResumed(compacted ?? ctx.initialMessages ?? []);
    } catch (err) {
      pushOutput(`Compaction failed: ${(err as Error).message}. Loading full transcript.`);
      replayResumed(ctx.initialMessages ?? []);
    } finally {
      setCompactingResume(false);
    }
  }, [ctx.compactResumed, ctx.initialMessages, replayResumed]);

  const runAgentTurn = useCallback(
    async (input: string, imageUrls?: string[]) => {
      if (!input.trim()) return;

      turnActiveRef.current = true;

      const scheduleOutput = (line: string) => {
        if (rawMode.mode === "raw") {
          process.stdout.write(line + "\n");
        } else {
          outputQueueRef.current.push(line);
        }
      };

      setActiveLineBoth("");
      setBusy(true);
      setTurnActive(true);
      setFirstTokenBoth(false);
      startFlushTimer();
      startSpinner();
      startElapsedTimer();
      cancelled.current = false;
      reasoningRef.current = { buffer: "", flushed: false };
      const turnStart = Date.now();

      announceToScreenReader("Heirloom is processing your request", "polite");

      // Echo the user's message as a full-width highlighted bar with a "›"
      // chevron (Claude Code style) — the background fill makes input
      // unmistakable, so the assistant reply below can stay plain flush-left
      // text marked only by a leading "●" bullet.
      scheduleOutput("");
      scheduleOutput(USER_ECHO_TAG + input);
      scheduleOutput("");

      // The assistant's answer opens with a dim "●" bullet on the first line of
      // a fresh answer block; continuation lines stay plain. `atBlockStart` is
      // true until the first non-empty text line of the current block is
      // emitted, then resets after each tool call so the next answer re-bullets.
      let atBlockStart = true;
      const bullet = theme.colorEnabled ? "\x1b[2m●\x1b[0m " : "● ";
      const withBullet = (line: string): string =>
        atBlockStart ? bullet + line : line;

      let textBuffer = "";
      // The blank line after the echo already separates the reply, so the first
      // text/tool block does not need to add its own leading blank.
      let needTextSeparator = false;

      function flushReasoning() {
        const { buffer, flushed } = reasoningRef.current;
        if (flushed || !buffer.trim()) return;
        reasoningRef.current.flushed = true;
        if (rawMode.mode === "normal") {
          const line = theme.colorEnabled ? `\x1b[2m✱ ${buffer.trim()}\x1b[0m` : `✱ ${buffer.trim()}`;
          scheduleOutput(line);
        } else {
          const summary = buffer.trim().replace(/\s+/g, " ").slice(0, 100);
          const line = theme.colorEnabled ? `\x1b[2m✱ ${summary}\x1b[0m` : `✱ ${summary}`;
          scheduleOutput(line);
        }
      }

      const callbacks = {
        onReasoning: (c: string) => {
          if (!firstTokenRef.current) {
            setFirstTokenBoth(true);
            setBusy(false);
          }
          reasoningRef.current.buffer += c;
        },
        onText: (c: string) => {
          flushReasoning();
          if (!firstTokenRef.current) {
            setFirstTokenBoth(true);
            setBusy(false);
          }
          if (needTextSeparator && textBuffer === "" && c.trim() !== "") {
            needTextSeparator = false;
            scheduleOutput("");
          }
          textBuffer += c;
          const rawLines = textBuffer.split("\n");
          for (let i = 0; i < rawLines.length - 1; i++) {
            const line = rawLines[i];

            if (line.startsWith("```")) {
              if (codeBlockRef.current.active) {
                codeBlockRef.current.lines.push(line);
                const block = codeBlockRef.current.lines.join("\n");
                codeBlockRef.current = { active: false, lines: [] };
                scheduleOutput(withBullet(block));
                atBlockStart = false;
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

            scheduleOutput(withBullet(line));
            atBlockStart = false;
          }
          textBuffer = rawLines[rawLines.length - 1];
          if (codeBlockRef.current.active) {
            const preview =
              codeBlockRef.current.lines.join("\n") +
              (textBuffer ? "\n" + textBuffer : "");
            setActiveLineBoth(withBullet(preview));
          } else {
            setActiveLineBoth(textBuffer === "" ? "" : withBullet(textBuffer));
          }
        },
        onToolStart: (name: string, args: Record<string, unknown>) => {
          flushReasoning();
          if (activeLineRef.current) scheduleOutput(activeLineRef.current);
          setActiveLineBoth("");
          textBuffer = "";
          atBlockStart = true; // next answer block re-bullets after this tool call
          scheduleOutput("");
          const header = formatToolCallHeader(name, args);
          scheduleOutput(header);
        },
        onToolResult: (
          _name: string,
          result: { content: string; error?: string },
        ) => {
          const content = result.error
            ? `Error: ${result.error}`
            : (result.content ?? "");
          if (content.trim() !== "") {
            const isError = !!result.error || content.startsWith("PERMISSION_DENIED") || content.startsWith("COMMAND_FAILED");
            for (const line of formatToolResultPreview(content)) {
              if (theme.colorEnabled) {
                scheduleOutput(isError ? `\x1b[31m${line}\x1b[0m` : `\x1b[2m${line}\x1b[0m`);
              } else {
                scheduleOutput(line);
              }
            }
          }
          needTextSeparator = true;
        },
        onDiagnostic: () => {},
        onRetry: () => {},
        onCompacted: () => {},
        onLoopDetected: (m: string) => {
          scheduleOutput(`[${m}]`);
        },
        onMaxTurns: () => {
          scheduleOutput("[max turns reached. Session saved.]");
        },
        onUsage: (input: number, output: number) => {
          setTokenCounts((prev) => ({
            input: (prev?.input ?? 0) + input,
            output: (prev?.output ?? 0) + output,
          }));
          setStatusLine(ctx.buildStatusBar());
        },
        onNewMessages: async (userInput: string, newMessages: any[]) => {
          await ctx.sessionStore.appendMessage(ctx.sessionId, {
            role: "user",
            content: userInput,
          });
          for (const msg of newMessages) {
            if (msg.role !== "system") {
              await ctx.sessionStore.appendMessage(ctx.sessionId, msg);
            }
          }
        },
        onHistoryUpdate: (messages: any[]) => {
          ctx.mutable.conversationHistory = messages;
        },
        askUser: async (
          toolName: string,
          args: Record<string, unknown>,
        ) => {
          if (
            [
              "edit",
              "edit_file",
              "write_to_file",
              "write",
              "search_replace",
              "apply_diff",
              "apply_patch",
            ].includes(toolName)
          ) {
            const preview = previewEdit(toolName, args);
            if (preview) scheduleOutput(preview);
          }

          const { action, winningRule, wasUnresolved, isGuarded } = ctx.permissions.resolve(toolName, args);

          // deny should never reach askUser (agent.ts only calls it for "ask"),
          // but handle defensively rather than assume the caller's invariant.
          if (action === "deny") return false;

          // Auto-approve posture bypasses an ordinary rule-derived ask, but
          // never a result the bash normalizer couldn't safely classify, and
          // never a secret-adjacent path guard — both must always surface the
          // real prompt, regardless of posture.
          if (ctx.mutable.posture === "autoApprove" && !wasUnresolved && !isGuarded) {
            return true;
          }

          return new Promise<boolean>((resolve) => {
            setAskPrompt({ resolve, toolName, args, winningRule, cursor: 0 });
          });
        },
      };

      setAskQuestion(async (questions) => {
        return new Promise<Record<string, string> | null>((resolve) => {
          setAskQuestionPrompt({ questions, resolve });
        });
      });

      try {
        const result = await ctx.runAgentTurnCore(input, callbacks, imageUrls, planMode);

        flushOutputQueue();

        if (
          codeBlockRef.current.active &&
          codeBlockRef.current.lines.length > 0
        ) {
          pushOutput(withBullet(codeBlockRef.current.lines.join("\n")));
          codeBlockRef.current = { active: false, lines: [] };
        }
        if (activeLineRef.current) pushOutput(activeLineRef.current);
        setActiveLineBoth("");
        textBuffer = "";

        // Per-turn completion footer: "✳ Worked for Ns" (dim), mirroring Claude
        // Code — a subtle marker that closes each response block. Padded with a
        // blank line on each side so it isn't crammed against the reply above or
        // the next turn below.
        const elapsedS = Math.max(1, Math.round((Date.now() - turnStart) / 1000));
        const footer = `✳ Worked for ${elapsedS}s`;
        pushOutput("");
        pushOutput(theme.colorEnabled ? `\x1b[2m${footer}\x1b[0m` : footer);
        pushOutput("");

        if (result.stopReason === "done") {
          ctx.mutable.conversationHistory = result.messages;
          await callbacks.onNewMessages(input, result.newMessages);
        }

        if (planMode) {
          const lastAssistant = result.newMessages
            ? [...result.newMessages].reverse().find((m: any) => m.role === "assistant")
            : undefined;
          const replyText: string = lastAssistant?.content ?? "";
          const planMatch = replyText.match(/<proposed_plan>([\s\S]+?)<\/proposed_plan>/);
          if (planMatch && planMatch[1].trim()) {
            setPlanPrompt({ planText: planMatch[1].trim(), followUpPrompt: "" });
          }
        }

        announceToScreenReader("Heirloom has finished processing", "polite");
      } catch (err) {
        flushOutputQueue();
        pushOutput(`Error: ${(err as Error).message}`);
        announceToScreenReader(
          `Error: ${(err as Error).message}`,
          "assertive",
        );
      } finally {
        setAskQuestion(undefined);
        setAskQuestionPrompt(null);
        stopFlushTimer();
        setBusy(false);
        setTurnActive(false);
        stopSpinner();
        stopElapsedTimer();
        codeBlockRef.current = { active: false, lines: [] };
        ctx.renewAbortController();
        setStatusLine(ctx.buildStatusBar());
        turnActiveRef.current = false;
        drainQueueRef.current();
      }
    },
    [ctx, theme, rawMode, planMode],
  );

  // Drain the next queued submission (message or slash command) after a turn
  // ends. Held in a ref so `runAgentTurn`'s `finally` can call the latest
  // version without listing it as a useCallback dependency.
  const drainQueueRef = useRef<() => void>(() => {});
  drainQueueRef.current = () => {
    if (turnActiveRef.current) return;
    // Run queued slash commands synchronously in order; stop at the first
    // message, which starts an async turn that re-triggers this drain from its
    // `finally` when it completes. A modal-opening slash command (e.g. /model,
    // /resume) also stops the drain — the modal owns the screen until dismissed,
    // and the remaining queue drains when the turn/modal flow next completes.
    while (!turnActiveRef.current) {
      const next = messageQueueRef.current.shift();
      syncQueueState();
      if (!next) return;
      if (next.kind === "slash") {
        handleSlashCommand(next.text);
        if (modalOpenRef.current) return;
      } else {
        runAgentTurn(next.text, next.imageUrls);
        return;
      }
    }
  };

  // Handles a submission from the input box: runs it now if idle, otherwise
  // enqueues it to drain after the in-flight turn(s) complete.
  function submitFromInput({ text, command, imageUrls }: { text: string; command?: string; imageUrls?: string[] }) {
    if (command) {
      if (command === "exit") { handleExit(); return; }
      if (turnActiveRef.current) {
        messageQueueRef.current.push({ kind: "slash", text: `/${command}`, at: Date.now() });
        syncQueueState();
        return;
      }
      handleSlashCommand(`/${command}`);
      return;
    }
    const isSlash = text.startsWith("/");
    if (turnActiveRef.current) {
      messageQueueRef.current.push(isSlash ? { kind: "slash", text, at: Date.now() } : { kind: "message", text, at: Date.now(), imageUrls });
      syncQueueState();
      return;
    }
    if (isSlash) {
      handleSlashCommand(text);
    } else {
      runAgentTurn(text, imageUrls);
    }
  }

  function applyPosture(next: Posture) {
    setPosture(next);
    setPlanPrompt(null);
    // Posture is UI-only state now: the permission engine has no session-wide
    // auto-approve flag. askUser reads ctx.mutable.posture directly and
    // bypasses only ordinary rule-derived asks — deny and unresolved-ask
    // results are never bypassed regardless of posture.
    ctx.mutable.posture = next;
    setStatusLine(ctx.buildStatusBar());
  }

  function cyclePosture() {
    const order: Posture[] = ["normal", "autoApprove", "plan"];
    const idx = order.indexOf(posture);
    applyPosture(order[(idx + 1) % order.length]);
  }

  function handleSlashCommand(trimmed: string) {
    // Echo the command into scrollback as a lightweight dim line, so there's a
    // visible record of what was typed. Commands make no model call, so this is
    // never counted toward context usage.
    pushOutput(COMMAND_ECHO_TAG + trimmed);
    if (trimmed === "/exit") {
      handleExit();
      return;
    }
    if (trimmed === "/model") {
      setShowModelDropdown(true);
      return;
    }
    if (trimmed === "/theme") {
      themeBeforePreviewRef.current = themeController.current;
      setShowThemeDropdown(true);
      return;
    }
    if (trimmed === "/new") {
      // Start a fresh conversation: drop the model-visible history and wipe the
      // scrollback so the session reads as new. Same history reset as /clear,
      // plus a visible-transcript clear the bare /clear doesn't do.
      ctx.mutable.conversationHistory = [];
      setOutputLines([]);
      pushOutput("[started a fresh conversation]");
      return;
    }
    if (trimmed === "/plan") {
      // Toggle the plan posture on/off — the same posture Shift+Tab cycles to.
      applyPosture(posture === "plan" ? "normal" : "plan");
      pushOutput(posture === "plan" ? "[plan mode off]" : "[plan mode on]");
      return;
    }
    if (trimmed === "/resume" || trimmed === "/continue" || trimmed === "/sessions") {
      setShowSessionList(true);
      return;
    }
    if (trimmed === "/undo") {
      setShowUndoSelector(true);
      return;
    }
    if (trimmed === "/mcp") {
      setShowMcpStatus(true);
      return;
    }
    if (trimmed === "/permissions" || trimmed === "/permissions history") {
      setShowPermissionHistory(true);
      return;
    }
    if (trimmed.startsWith("/raw")) {
      const arg = trimmed.slice(4).trim();
      if (arg === "normal") rawMode.setMode("normal");
      else if (arg === "raw" || arg === "raw-scrollback") rawMode.setMode("raw");
      else {
        const next = rawMode.mode === "lite" ? "normal" : rawMode.mode === "normal" ? "raw" : "lite";
        rawMode.setMode(next);
        pushOutput(`Display mode: ${next}`);
      }
      setStatusLine(ctx.buildStatusBar());
      return;
    }
    ctx.handleSlash(trimmed).then((lines) => {
      for (const line of lines) pushOutput(line);
      setStatusLine(ctx.buildStatusBar());
    });
  }

  const paletteActions: CommandPaletteAction[] = useMemo(
    () => [
      {
        id: "cmd-help",
        label: "/help",
        description: "Show help and keyboard shortcuts",
        category: "command",
        execute: () => setShowHelp(true),
      },
      {
        id: "cmd-clear",
        label: "/clear",
        description: "Clear conversation history",
        category: "command",
        execute: () => handleSlashCommand("/clear"),
      },
      {
        id: "cmd-exit",
        label: "/exit",
        description: "Exit the CLI",
        category: "command",
        execute: () => handleExit(),
      },
      {
        id: "cmd-cost",
        label: "/cost",
        description: "Show session token totals and cost",
        category: "command",
        execute: () => handleSlashCommand("/cost"),
      },
      {
        id: "cmd-mode",
        label: "/mode",
        description: "Switch persona (code/ask/architect/debug/orchestrator)",
        category: "command",
        execute: () => handleSlashCommand("/modes"),
      },
      {
        id: "cmd-model",
        label: "/model",
        description: "Switch model",
        category: "command",
        execute: () =>
          setShowModelDropdown(true),
      },
      {
        id: "cmd-sessions",
        label: "/sessions",
        description: "List sessions",
        category: "command",
        execute: () => handleSlashCommand("/sessions"),
      },
      {
        id: "cmd-new",
        label: "/new",
        description: "Start a fresh conversation",
        category: "command",
        execute: () => handleSlashCommand("/new"),
      },
      {
        id: "cmd-plan",
        label: "/plan",
        description: "Toggle plan mode",
        category: "command",
        execute: () => handleSlashCommand("/plan"),
      },
      {
        id: "cmd-skills",
        label: "/skills",
        description: "List available skills",
        category: "command",
        execute: () => handleSlashCommand("/skills"),
      },
      {
        id: "action-help",
        label: "Keyboard Shortcuts",
        description: "Show keyboard shortcuts overlay",
        category: "action",
        execute: () => setShowHelp(true),
      },
      {
        id: "action-palette",
        label: "Command Palette",
        description: "Open command palette",
        category: "action",
        execute: () => setShowCommandPalette(true),
      },
      {
        id: "action-model-picker",
        label: "Open Model Picker",
        description: "Select a different AI model",
        category: "action",
        execute: () =>
          setShowModelDropdown(true),
      },
    ],
    [ctx, exit],
  );

  function resolveAskPrompt(allowed: boolean): void {
    setAskPrompt((prev) => {
      if (!prev) return null;
      const { resolve } = prev;
      setTimeout(() => resolve(allowed), 0);
      return null;
    });
    setBusy(true);
    startSpinner();
  }

  function handlePermissionDecision(decision: PermissionDecision): void {
    if (!askPrompt) return;

    const subject = String(askPrompt.args?.command ?? askPrompt.args?.path ?? askPrompt.args?.filePath ?? "");
    void ctx.sessionStore.appendPermission(ctx.sessionId, {
      tool: askPrompt.toolName,
      subject,
      decision,
      winningRule: askPrompt.winningRule,
    });

    if (decision === "deny") {
      resolveAskPrompt(false);
      return;
    }

    if (decision === "session" || decision === "always") {
      const rule = askPrompt.winningRule ?? ctx.permissions.buildDefaultRule(askPrompt.toolName, askPrompt.args);
      const isBuiltinOrigin = askPrompt.winningRule?.origin === "builtin-destructive" || askPrompt.winningRule?.origin === "builtin-guarded";
      const matchedBuiltin = isBuiltinOrigin ? askPrompt.winningRule : undefined;
      if (decision === "session") {
        ctx.permissions.approveForSession(rule, matchedBuiltin);
      } else {
        ctx.permissions.approveAlways(rule, matchedBuiltin);
      }
    }

    resolveAskPrompt(true);
  }

  useInput((value: string, key: any) => {
    if (rawMode.mode === "raw") {
      if (key.escape) {
        rawMode.setMode("lite");
        pushOutput("[exited raw mode]");
        return;
      }
      if (key.ctrl && key.name === "c") {
        ctx.provideAbortController().abort();
        return;
      }
      return;
    }

    // The startup resume chooser owns input until dismissed (it has its own
    // useInput); block the main handler while it — or its compaction — is up.
    if (resumeChoice || compactingResume) return;

    if (showHelp) return;
    if (showCommandPalette) return;
    if (showModelDropdown) return;
    if (showThemeDropdown) return;

    if (planPrompt) {
      return;
    }

    if (showSessionList) {
      return;
    }

    if (showUndoSelector) {
      return;
    }

    if (showMcpStatus) {
      return;
    }

    if (showPermissionHistory) {
      return;
    }

    if (askQuestionPrompt) {
      return;
    }

    if (askPrompt) {
      const lower = value.toLowerCase();
      const decisions: PermissionDecision[] = ["once", "session", "always", "deny"];

      if (key.escape) {
        resolveAskPrompt(false);
        return;
      }

      if (key.upArrow) {
        setAskPrompt((prev) => prev ? { ...prev, cursor: Math.max(0, prev.cursor - 1) } : null);
        return;
      }
      if (key.downArrow) {
        setAskPrompt((prev) => prev ? { ...prev, cursor: Math.min(decisions.length - 1, prev.cursor + 1) } : null);
        return;
      }

      if (lower === "1" || lower === "2" || lower === "3" || lower === "4") {
        handlePermissionDecision(decisions[Number(lower) - 1]);
        return;
      }

      if (key.return) {
        handlePermissionDecision(decisions[askPrompt.cursor]);
        return;
      }
      return;
    }

    // No modal view is active, so PromptInput is the focused input surface and
    // owns typing, submission/queuing, and Esc/Ctrl+C interrupt (whether idle or
    // busy). This top-level handler only governs modal views (handled above) and
    // global chord shortcuts below — it must NOT consume plain keys or re-handle
    // interrupt here, or it would double-fire against PromptInput.
    const actions = lookupAction(key, bindings);

    if (actions.includes("openModelPicker")) {
      setShowModelDropdown(true);
      return;
    }

    if (actions.includes("openCommandPalette")) {
      setShowCommandPalette(true);
      accessibility.announce("Command palette opened", "polite");
      return;
    }
  });

  function handleExit() {
    const usage = ctx.mutable.modelUsage;
    if (usage && Object.keys(usage).length > 0) {
      pushOutput(buildExitSummaryText(usage));
    }
    pushOutput(buildResumeHintText(ctx.sessionId, colorEnabled));
    ctx.logSessionEnd().finally(() => exit());
  }

  const promptStr = ctx.getPromptStr();
  const colorEnabled = theme.colorEnabled;
  const term = useTerminalInfo();

  const modalOpen =
    !!askPrompt || !!askQuestionPrompt || !!planPrompt || showSessionList ||
    showUndoSelector || showMcpStatus || showPermissionHistory || showModelDropdown || showThemeDropdown || showHelp || showCommandPalette ||
    !!resumeChoice || compactingResume;
  modalOpenRef.current = modalOpen;

  return (
    <Box flexDirection="column" width={term.columns}>
      {/* Banner stays pinned at the top of the frame for the whole session;
          the conversation renders below it rather than replacing it. */}
      <WelcomeScreen
        model={`${ctx.providerName}/${ctx.activeModel ?? "unknown"}`}
        thinkingEnabled={thinkingEnabled}
        reasoningEffort={reasoningEffort}
        cwd={process.cwd()}
        width={term.columns}
      />
      <OutputArea
        lines={outputLines}
        activeLine={activeLine}
        busy={busy}
      />

      <Spinner active={turnActive} frame={spinnerFrame} elapsed={turnElapsed} />

      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}

      {showCommandPalette && (
        <CommandPalette
          actions={paletteActions}
          onClose={() => setShowCommandPalette(false)}
        />
      )}

      {askQuestionPrompt && (
        <AskUserQuestionPrompt
          questions={askQuestionPrompt.questions}
          resolve={(answers) => {
            setAskQuestionPrompt(null);
            askQuestionPrompt.resolve(answers);
          }}
          width={term.columns}
        />
      )}

      {askPrompt && (askPrompt.winningRule?.origin === "builtin-destructive" ? (
        <DestructiveConfirmPrompt
          request={{
            toolName: askPrompt.toolName,
            command: String(askPrompt.args?.command ?? askPrompt.args?.path ?? ""),
            winningRule: askPrompt.winningRule,
          }}
          cursor={askPrompt.cursor}
          onChoose={handlePermissionDecision}
          onCancel={() => resolveAskPrompt(false)}
        />
      ) : (
        <PermissionPrompt
          request={{
            toolName: askPrompt.toolName,
            command: String(askPrompt.args?.command ?? askPrompt.args?.path ?? ""),
            winningRule: askPrompt.winningRule,
          }}
          cursor={askPrompt.cursor}
          onChoose={handlePermissionDecision}
          onCancel={() => resolveAskPrompt(false)}
        />
      ))}

      {planPrompt && (
        <PlanImplementationPrompt
          planText={planPrompt.planText}
          onImplement={(followUpPrompt) => {
            setPlanPrompt(null);
            applyPosture("normal");
            runAgentTurn(followUpPrompt);
          }}
          onStayInPlan={() => {
            setPlanPrompt(null);
          }}
          onSwitchToDefault={() => {
            setPlanPrompt(null);
            applyPosture("normal");
          }}
        />
      )}

      {showSessionList && (
        <SessionList
          sessionStore={ctx.sessionStore}
          onResume={async (sessionId) => {
            if (ctx.resumeSession) {
              const ok = await ctx.resumeSession(sessionId);
              if (ok) {
                setShowSessionList(false);
                setOutputLines([]);
              }
            }
          }}
          onClose={() => setShowSessionList(false)}
          width={term.columns}
          height={term.rows}
        />
      )}

      {showUndoSelector && (
        <UndoSelector
          checkpoints={(ctx.checkpoints?.list() as any[]) ?? []}
          onRestore={async (hash, restoreCode) => {
            if (ctx.restoreCheckpoint) {
              const result = await ctx.restoreCheckpoint(hash, restoreCode);
              if (result.restored) {
                setShowUndoSelector(false);
                setOutputLines([]);
                if (result.promptDraft) {
                  draftNonceRef.current += 1;
                  setPromptDraft({ nonce: draftNonceRef.current, text: result.promptDraft });
                }
              }
              return result;
            }
            return { restored: false, promptDraft: "" };
          }}
          onClose={() => setShowUndoSelector(false)}
          width={term.columns}
          height={term.rows}
        />
      )}

      {showMcpStatus && (
        <McpStatusList
          onClose={() => setShowMcpStatus(false)}
          width={term.columns}
        />
      )}

      {showPermissionHistory && (
        <PermissionHistoryList
          sessionStore={ctx.sessionStore}
          sessionId={ctx.sessionId}
          onClose={() => setShowPermissionHistory(false)}
          width={term.columns}
        />
      )}

      {showModelDropdown && (
        <ModelsDropdown
          open={showModelDropdown}
          providerName={ctx.providerName}
          currentModel={ctx.activeModel}
          width={term.columns}
          onClose={() => setShowModelDropdown(false)}
          onSelect={async (provider, model) => {
            const lines = await ctx.handleSlash(`/model ${provider}/${model}`);
            for (const line of lines) pushOutput(line);
            setStatusLine(ctx.buildStatusBar());
          }}
        />
      )}

      {showThemeDropdown && (
        <ThemeDropdown
          open={showThemeDropdown}
          currentName={themeBeforePreviewRef.current}
          width={term.columns}
          onPreview={(name) => themeController.setThemeName(name)}
          onConfirm={(name) => {
            themeController.setThemeName(name);
            try {
              persistThemeChoice(name);
              pushOutput(`Theme set to ${name}.`);
            } catch (err) {
              pushOutput(`Failed to save theme: ${(err as Error).message}`);
            }
            setShowThemeDropdown(false);
          }}
          onCancel={() => {
            // Revert the live preview to the theme active when the picker opened.
            themeController.setThemeName(themeBeforePreviewRef.current);
            setShowThemeDropdown(false);
          }}
        />
      )}

      {resumeChoice && !compactingResume && (
        <ResumeChooser
          messageCount={resumeChoice.count}
          onLoad={handleResumeLoad}
          onCompact={handleResumeCompact}
          width={term.columns}
        />
      )}

      {compactingResume && (
        <Box marginY={1}>
          <Text color="cyan">✳ </Text>
          <Text dimColor>Compacting resumed session…</Text>
        </Box>
      )}

      {/* Queued follow-ups entered mid-turn, stacked one per line in arrival
          order just above the input, so the user sees what's lined up to run
          when the current turn finishes. */}
      {queuedItems.length > 0 && (
        <Box flexDirection="column">
          {queuedItems.map((item, i) => (
            <Text key={i} color="magenta" dimColor>
              {`${formatQueueTime(item.at)} ${queuedLabel(item.text)}`}
            </Text>
          ))}
        </Box>
      )}

      {!askPrompt && !askQuestionPrompt && !planPrompt && !showSessionList && !showUndoSelector && !showMcpStatus && !showPermissionHistory && !showModelDropdown && !showThemeDropdown && !showHelp && !showCommandPalette && !resumeChoice && !compactingResume && (
        <PromptInput
          screenWidth={term.columns}
          promptHistory={[]}
          busy={busy}
          placeholder="Type your message..."
          promptDraft={promptDraft}
          onSubmit={submitFromInput}
          onInterrupt={() => ctx.provideAbortController().abort()}
          onExitShortcut={() => handleExit()}
          onModelPickerOpen={() => setShowModelDropdown(true)}
          onCyclePosture={() => cyclePosture()}
        />
      )}

      <StatusBar
        segments={
          statusLineProviderSegments.length > 0
            ? [...statusLine, ...statusLineProviderSegments]
            : statusLine
        }
        gitStatus={gitStatus}
        showTimer
        sessionStart={sessionStart}
        tokenCounts={tokenCounts}
      />
    </Box>
  );
}

interface AppProps {
  ctx: AppContext;
  themeConfig?: ThemeProviderOptions;
  keybindingConfig?: KeybindingConfig;
}

export default function App({
  ctx,
  themeConfig,
  keybindingConfig,
}: AppProps) {
  const colorEnabled = ctx.getColorEnabled();

  return (
    <ErrorBoundary colorEnabled={colorEnabled}>
      <ThemeProvider
        config={{
          mode: themeConfig?.mode ?? "dark",
          name: themeConfig?.name,
          overrides: themeConfig?.overrides,
          colorEnabled,
        }}
      >
        <KeybindingProvider config={keybindingConfig}>
          <TerminalProvider>
            <AccessibilityProvider>
              <RawModeProvider>
              <InnerApp ctx={ctx} />
              </RawModeProvider>
            </AccessibilityProvider>
          </TerminalProvider>
        </KeybindingProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
