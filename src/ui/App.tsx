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
import type { PermissionScope } from "../permissions/index.js";
import type { KeybindingConfig } from "./keybindings.js";

import {
  ThemeProvider,
  type ThemeProviderOptions,
  useTheme,
  KeybindingProvider,
  useKeybindings,
  TerminalProvider,
  useTerminalInfo,
  AccessibilityProvider,
  useAccessibility,
} from "./contexts.js";
import ErrorBoundary from "./ErrorBoundary.js";
import HelpOverlay from "./HelpOverlay.js";
import CommandPalette, {
  type CommandPaletteAction,
} from "./CommandPalette.js";

import OutputArea from "./OutputArea.js";
import Spinner from "./Spinner.js";
import PermissionPrompt from "./PermissionPrompt.js";
import WelcomeScreen from "./views/WelcomeScreen.js";
import PromptInput from "./views/PromptInput.js";
import AskUserQuestionPrompt from "./views/AskUserQuestionPrompt.js";
import type { AskQuestionItem } from "../tools/types.js";
import { setAskQuestion } from "../tools/index.js";
import { ModelsDropdown } from "./components/index.js";
import {
  SILENT_TOOLS,
  describeToolCall,
  SPINNER_FRAMES,
} from "./ToolCallFormatter.js";
import {
  lookupAction,
} from "./keybindings.js";
import { announceToScreenReader } from "./Accessibility.js";

function InnerApp({ ctx }: { ctx: AppContext }) {
  const { exit } = useApp();
  const theme = useTheme();
  const accessibility = useAccessibility();
  const bindings = useKeybindings();

  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [activeLine, setActiveLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [firstToken, setFirstToken] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [statusLine, setStatusLine] = useState<StatusSegment[]>(() =>
    ctx.buildStatusBar(),
  );
  const [askPrompt, setAskPrompt] = useState<{
    resolve: (v: boolean) => void;
    toolName: string;
    args: Record<string, unknown>;
    scopes: PermissionScope[];
    scopeIndex: number;
    cursor: number;
    alwaysAllows: PermissionScope[];
    denied: boolean;
  } | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [askQuestionPrompt, setAskQuestionPrompt] = useState<{
    questions: AskQuestionItem[];
    resolve: (answers: Record<string, string> | null) => void;
  } | null>(null);

  const [showHelp, setShowHelp] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const [sessionStart] = useState(() => Date.now());
  const [tokenCounts, setTokenCounts] = useState<{
    input: number;
    output: number;
  } | null>(null);

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
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
    const interval = setInterval(refreshGit, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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
    setFirstToken(v);
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
    async (input: string, imageUrls?: string[]) => {
      if (!input.trim()) return;

      const scheduleOutput = (line: string) =>
        outputQueueRef.current.push(line);

      setActiveLineBoth("");
      setBusy(true);
      setFirstTokenBoth(false);
      startFlushTimer();
      startSpinner();
      cancelled.current = false;
      reasoningRef.current = { buffer: "", flushed: false };

      announceToScreenReader("Heirloom is processing your request", "polite");

      let textBuffer = "";

      function flushReasoning() {
        const { buffer, flushed } = reasoningRef.current;
        if (flushed || !buffer.trim()) return;
        reasoningRef.current.flushed = true;
        const summary = buffer.trim().replace(/\s+/g, " ").slice(0, 100);
        const line = theme.colorEnabled ? `\x1b[2m✱ ${summary}\x1b[0m` : `✱ ${summary}`;
        scheduleOutput(line);
      }

      const callbacks = {
        onReasoning: (c: string) => {
          reasoningRef.current.buffer += c;
        },
        onText: (c: string) => {
          flushReasoning();
          if (!firstTokenRef.current) {
            setFirstTokenBoth(true);
            setBusy(false);
            stopSpinner();
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
            const preview =
              codeBlockRef.current.lines.join("\n") +
              (textBuffer ? "\n" + textBuffer : "");
            setActiveLineBoth(preview);
          } else {
            setActiveLineBoth(textBuffer);
          }
        },
        onToolStart: (name: string, args: Record<string, unknown>) => {
          flushReasoning();
          if (activeLineRef.current) scheduleOutput(activeLineRef.current);
          setActiveLineBoth("");
          if (SILENT_TOOLS.has(name)) {
            textBuffer = "";
            return;
          }
          const desc = describeToolCall(name, args);
          if (theme.colorEnabled) {
            scheduleOutput(`\x1b[2m  ${desc}\x1b[0m`);
          } else {
            scheduleOutput(`  ${desc}`);
          }
          textBuffer = "";
        },
        onToolResult: (
          _name: string,
          result: { content: string; error?: string },
        ) => {
          if (result.content?.startsWith("PERMISSION_DENIED")) {
            scheduleOutput("  Permission denied");
          } else if (result.content?.startsWith("COMMAND_FAILED")) {
            scheduleOutput(`  Command failed: ${result.content.slice(16)}`);
          }
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
          const scopes = ctx.permissions.classifyScopes(toolName, args);
          return new Promise<boolean>((resolve) => {
            setAskPrompt({ resolve, toolName, args, scopes, scopeIndex: 0, cursor: 0, alwaysAllows: [], denied: false });
          });
        },
      };

      setAskQuestion(async (questions) => {
        return new Promise<Record<string, string> | null>((resolve) => {
          setAskQuestionPrompt({ questions, resolve });
        });
      });

      try {
        const result = await ctx.runAgentTurnCore(input, callbacks, imageUrls);

        flushOutputQueue();

        if (
          codeBlockRef.current.active &&
          codeBlockRef.current.lines.length > 0
        ) {
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
        stopSpinner();
        codeBlockRef.current = { active: false, lines: [] };
        ctx.renewAbortController();
        setStatusLine(ctx.buildStatusBar());
      }
    },
    [ctx, theme],
  );

  function handleSlashCommand(trimmed: string) {
    if (trimmed === "/exit") {
      ctx.logSessionEnd().finally(() => exit());
      return;
    }
    if (trimmed === "/model") {
      setShowModelDropdown(true);
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
        execute: () => ctx.logSessionEnd().finally(() => exit()),
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
        id: "cmd-checkpoint",
        label: "/checkpoint",
        description: "Save manual checkpoint",
        category: "command",
        execute: () => handleSlashCommand("/checkpoint"),
      },
      {
        id: "cmd-checkpoints",
        label: "/checkpoints",
        description: "List checkpoints",
        category: "command",
        execute: () => handleSlashCommand("/checkpoints"),
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
        description: "Start new session",
        category: "command",
        execute: () => handleSlashCommand("/new"),
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

  function advancePrompt(decision: "allow" | "deny"): void {
    setAskPrompt((prev) => {
      if (!prev) return null;
      const nextIndex = prev.scopeIndex + 1;
      if (nextIndex >= prev.scopes.length) {
        const { resolve } = prev;
        setTimeout(() => resolve(!prev.denied), 0);
        return null;
      }
      return { ...prev, scopeIndex: nextIndex, cursor: 0 };
    });
    setBusy(true);
    startSpinner();
  }

  useInput((value: string, key: any) => {
    if (showHelp) return;
    if (showCommandPalette) return;
    if (showModelDropdown) return;

    if (askQuestionPrompt) {
      return;
    }

    if (askPrompt) {
      const lower = value.toLowerCase();

      if (key.escape) {
        const { resolve } = askPrompt;
        setAskPrompt(null);
        resolve(false);
        return;
      }

      if (key.upArrow) {
        setAskPrompt((prev) => prev ? { ...prev, cursor: Math.max(0, prev.cursor - 1) } : null);
        return;
      }
      if (key.downArrow) {
        setAskPrompt((prev) => prev ? { ...prev, cursor: Math.min(2, prev.cursor + 1) } : null);
        return;
      }

      if (lower === "1" || lower === "2" || lower === "3") {
        const idx = Number(lower) - 1;
        const kinds: Array<"allow" | "always" | "deny"> = ["allow", "always", "deny"];
        const decision = kinds[idx];
        const scope = askPrompt.scopes[askPrompt.scopeIndex];
        if (!scope) return;

        if (decision === "always") {
          ctx.permissions.persistAllow([scope]);
          const isFirstScope = askPrompt.scopeIndex === 0;
          if (isFirstScope) {
            firstTokenRef.current = askPrompt.scopes.every(s => s === scope);
          }
          advancePrompt("allow");
        } else if (decision === "deny") {
          setAskPrompt((prev) => prev ? { ...prev, denied: true } : null);
          advancePrompt("deny");
        } else {
          advancePrompt("allow");
        }
        return;
      }

      if (key.return) {
        const kinds: Array<"allow" | "always" | "deny"> = ["allow", "always", "deny"];
        const decision = kinds[askPrompt.cursor];
        const scope = askPrompt.scopes[askPrompt.scopeIndex];
        if (!scope) return;

        if (decision === "always") {
          ctx.permissions.persistAllow([scope]);
          advancePrompt("allow");
        } else if (decision === "deny") {
          setAskPrompt((prev) => prev ? { ...prev, denied: true } : null);
          advancePrompt("deny");
        } else {
          advancePrompt("allow");
        }
        return;
      }
      return;
    }

    const actions = lookupAction(key, bindings);

    if (busy) {
      if (actions.includes("abort") || actions.includes("cancel") ||
          key.escape || (key.ctrl && key.name === "c")) {
        ctx.provideAbortController().abort();
      }
      return;
    }

    if (key.ctrl && key.name === "c" && !value) {
      ctx.provideAbortController().abort();
      ctx.renewAbortController();
      return;
    }

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

  const promptStr = ctx.getPromptStr();
  const colorEnabled = theme.colorEnabled;
  const term = useTerminalInfo();

  const showWelcome = outputLines.length === 0 && !busy;

  return (
    <Box flexDirection="column" width={term.columns}>
      {showWelcome ? (
        <WelcomeScreen
          model={`${ctx.providerName}/${ctx.activeModel ?? "unknown"}`}
          thinkingEnabled={true}
          cwd={process.cwd()}
          width={term.columns}
        />
      ) : (
        <OutputArea
          lines={outputLines}
          activeLine={activeLine}
          busy={busy}
        />
      )}

      <Spinner busy={busy} firstToken={firstToken} frame={spinnerFrame} />

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

      {askPrompt && (
        <PermissionPrompt
          request={{ toolName: askPrompt.toolName, command: String(askPrompt.args?.command ?? askPrompt.args?.path ?? ""), scopes: askPrompt.scopes }}
          scopeIndex={askPrompt.scopeIndex}
          cursor={askPrompt.cursor}
          onChoose={() => {}}
          onCancel={() => {
            const { resolve } = askPrompt;
            setAskPrompt(null);
            resolve(false);
          }}
        />
      )}

      {showModelDropdown && (
        <ModelsDropdown
          open={showModelDropdown}
          providerName={ctx.providerName}
          currentModel={ctx.activeModel}
          thinkingEnabled={true}
          reasoningEffort={undefined}
          width={term.columns}
          onClose={() => setShowModelDropdown(false)}
          onSelect={async (provider, model, thinkingEnabled, reasoningEffort) => {
            const lines = await ctx.handleSlash(`/model ${provider}/${model}`);
            for (const line of lines) pushOutput(line);
            setStatusLine(ctx.buildStatusBar());
          }}
        />
      )}

      {!busy && !askPrompt && !askQuestionPrompt && !showModelDropdown && !showHelp && !showCommandPalette && (
        <PromptInput
          screenWidth={term.columns}
          promptHistory={[]}
          busy={busy}
          placeholder="Type your message..."
          onSubmit={({ text, command, imageUrls }) => {
            if (command) {
              if (command === "exit") { ctx.logSessionEnd().finally(() => exit()); return; }
              handleSlashCommand(`/${command}`);
              return;
            }
            if (text.startsWith("/")) {
              handleSlashCommand(text);
            } else {
              runAgentTurn(text, imageUrls);
            }
          }}
          onInterrupt={() => ctx.provideAbortController().abort()}
          onExitShortcut={() => ctx.logSessionEnd().finally(() => exit())}
          onModelPickerOpen={() => setShowModelDropdown(true)}
          statusLineSegments={statusLine}
          statusLineSeparator=" · "
        />
      )}
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
          overrides: themeConfig?.overrides,
          colorEnabled,
        }}
      >
        <KeybindingProvider config={keybindingConfig}>
          <TerminalProvider>
            <AccessibilityProvider>
              <InnerApp ctx={ctx} />
            </AccessibilityProvider>
          </TerminalProvider>
        </KeybindingProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
