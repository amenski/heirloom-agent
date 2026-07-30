import type { Provider } from "./providers/types.js";
import type { Message, ToolCall, ToolDef, ToolOutput } from "./types.js";
import type { PermissionEngine } from "./permissions/index.js";
import type { ModeConfig } from "./modes/loader.js";
import type { Compactor } from "./compaction/compactor.js";
import type { DiagnosticRunner } from "./diagnostics/index.js";
import type { ErrorReflector } from "./selfreflection/index.js";
import type { ErrorRecovery } from "./errorrecovery/index.js";
import type { SkillDef } from "./skills/index.js";
import type { RepoMap } from "./repomap/index.js";
import type { MemoryStore } from "./memory/store.js";
import type { SessionStore, CompactionSummary } from "./sessions/store.js";
import { buildStablePreamble, buildVolatileContext, type PromptContext } from "./prompt.js";

export type ToolExecutor = (call: ToolCall) => Promise<ToolOutput>;

// Rebuilding the stable preamble is pure string concatenation, but it's still
// wasted work every turn when nothing it depends on has changed — and more
// importantly, recomputing it is how a would-be-stable prefix accidentally
// drifts. Cache it keyed on the primitive inputs that feed buildStablePreamble;
// reuse the previous string when they're unchanged (mode/skills are stable
// object references across turns, only reassigned on explicit mode/skill
// switches). One CLI process runs one agent loop at a time, so a module-level
// cache is safe here.
let stableCache: { mode?: ModeConfig; workingDir: string; skills?: SkillDef[]; memory?: string; text: string } | undefined;

function getStablePreamble(ctx: PromptContext): string {
  if (
    stableCache &&
    stableCache.mode === ctx.mode &&
    stableCache.workingDir === ctx.workingDir &&
    stableCache.skills === ctx.skills &&
    stableCache.memory === ctx.memory
  ) {
    return stableCache.text;
  }
  const text = buildStablePreamble(ctx);
  stableCache = { mode: ctx.mode, workingDir: ctx.workingDir, skills: ctx.skills, memory: ctx.memory, text };
  return text;
}

export type AgentResult = {
  messages: Message[];
  newMessages: Message[];
  stopReason: "done" | "aborted" | "max_turns";
};

export interface AgentOptions {
  provider: Provider;
  tools: ToolDef[];
  executeTool: ToolExecutor;
  permissions?: PermissionEngine;
  mode?: ModeConfig;
  compactor?: Compactor;
  diagnostics?: DiagnosticRunner;
  errorReflector?: ErrorReflector;
  errorRecovery?: ErrorRecovery;
  maxTurns?: number;
  skills?: SkillDef[];
  repomap?: RepoMap;
  memory?: string;
  memoryStore?: MemoryStore;
  sessionStore?: SessionStore;
  sessionId?: string;
  signal?: AbortSignal;
  effort?: string;
  history?: Message[];
  imageUrls?: string[];
  planMode?: boolean;
  onText?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: ToolOutput) => void;
  onDiagnostic?: (msg: string) => void;
  onRetry?: (msg: string) => void;
  onCompacted?: (msg: string) => void;
  onLoopDetected?: (msg: string) => void;
  onMaxTurns?: (messages: Message[]) => void;
  onUsage?: (input: number, output: number, cached?: number) => void;
  askUser?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
}

export async function runAgent(
  userMessage: string,
  options: AgentOptions,
): Promise<AgentResult> {
  const { provider, tools, executeTool, permissions, compactor, diagnostics, errorReflector, errorRecovery, maxTurns = 20, effort } = options;

  const promptCtx: PromptContext = {
    mode: options.mode,
    workingDir: process.cwd(),
    skills: options.skills,
    repomap: options.repomap,
    memory: options.memory,
    conversation: userMessage,
    planMode: options.planMode,
  };
  const stablePreamble = getStablePreamble(promptCtx);
  const volatileContext = await buildVolatileContext(promptCtx);

  let messages: Message[] = options.history ? [...options.history] : [];
  // The system prompt lives at position 0 only, and holds only the stable
  // preamble — replacing it every turn with byte-identical content (the
  // common case) is a no-op for the provider's prefix cache. Volatile context
  // (RepoMap, plan-mode instruction, env/git) is attached to the user turn
  // only in the request sent to the provider (see withVolatilePrefix below),
  // never stored on `messages`, so it reaches the model every turn without
  // ever mutating the cached system prefix or polluting history.
  if (messages[0]?.role === "system") messages.shift();
  messages.unshift({ role: "system", content: stablePreamble });
  messages.push({ role: "user", content: userMessage, ...(options.imageUrls?.length ? { imageUrls: options.imageUrls } : {}) });
  const newStart = messages.length;

  // Volatile context is injected only into the request sent to the provider,
  // never into the stored `messages` array — otherwise it would accumulate in
  // history and bake stale RepoMap/env snapshots into every past user turn.
  // Reattach it each sub-turn to the last user-role message (the turn's
  // opening user message stays last-user as assistant/tool messages append
  // after it), so it reaches the model on every streamChat call this turn.
  function withVolatilePrefix(msgs: Message[], prefix: string): Message[] {
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        idx = i;
        break;
      }
    }
    if (idx === -1) return msgs;
    const copy = [...msgs];
    const target = copy[idx] as Message & { role: "user" };
    copy[idx] = { ...target, content: `${prefix}\n\n${target.content}` };
    return copy;
  }

  let stopReason: "done" | "aborted" | "max_turns" = "done";
  let turn = 0;
  let turnEnded = false;
  while (turn < maxTurns && !turnEnded) {
    if (options.signal?.aborted) {
      stopReason = "aborted";
      break;
    }
    const seenCalls = new Map<string, number>();
    let failedStreak = 0;
    let warnedRepeat = false;
    let warnedFailures = false;

    try {
    turn++;
    errorReflector?.resetTurn();
    errorRecovery?.reset();

    let content = "";
    let reasoning = "";
    const pendingCalls: Map<string, { name: string; args: string }> = new Map();

    try {
    const requestMessages = volatileContext ? withVolatilePrefix(messages, volatileContext) : messages;
    for await (const event of provider.streamChat(requestMessages, tools, { signal: options.signal, effort })) {
      switch (event.type) {
        case "text_delta":
          content += event.content;
          options.onText?.(event.content);
          break;
        case "reasoning_delta":
          reasoning += event.content;
          options.onReasoning?.(event.content);
          break;
        case "tool_call_start":
          pendingCalls.set(event.id, { name: event.name, args: "" });
          break;
        case "tool_call_delta": {
          const entry = pendingCalls.get(event.id);
          if (entry) entry.args += event.arguments;
          break;
        }
        case "usage":
          options.onUsage?.(event.inputTokens, event.outputTokens, event.cachedInputTokens);
          break;
        case "done":
          break;
      }
    }
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || (err as any).name === "AbortError")) {
        options.onDiagnostic?.("aborted by user");
        stopReason = "aborted";
        break;
      }
      throw err;
    }

    if (content) options.onText?.("\n");

    if (reasoning) messages.push({ role: "assistant", content: reasoning, meta: { asThinking: true } });

    if (pendingCalls.size === 0) {
      if (content) messages.push({ role: "assistant", content });
      break;
    }

    const toolCalls: ToolCall[] = [];
    let retryWithCorrection = false;

    for (const [id, tc] of pendingCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.args || "{}");
      } catch {
        if (tc.args && errorRecovery) {
          const correctionMsg = errorRecovery.handleParseError(tc.args);
          if (correctionMsg) {
            messages.push({ role: "assistant", content: content || null });
            messages.push({ role: "system", content: correctionMsg });
            retryWithCorrection = true;
            break;
          }
        }
        args = { _raw: tc.args };
      }
      toolCalls.push({ id, name: tc.name, arguments: args });
    }

    if (retryWithCorrection) continue;

    messages.push({
      role: "assistant",
      content: content || null,
      toolCalls,
    });

    diagnostics?.snapshot();

    for (const tc of toolCalls) {
      options.onToolStart?.(tc.name, tc.arguments);

      if (permissions) {
        const { action } = permissions.resolve(tc.name, tc.arguments);
        if (action === "deny") {
          const msg = `Permission denied for ${tc.name}`;
          options.onDiagnostic?.("denied");
          messages.push({ role: "tool", toolCallId: tc.id, content: msg });
          continue;
        }
        if (action === "ask") {
          if (options.askUser) {
            const allowed = await options.askUser(tc.name, tc.arguments);
            if (!allowed) {
              const msg = "PERMISSION_DENIED: denied by user";
              options.onDiagnostic?.("denied");
              messages.push({ role: "tool", toolCallId: tc.id, content: msg });
              continue;
            }
          } else {
            const msg = "PERMISSION_DENIED: headless — rule resolved to ask";
            options.onDiagnostic?.("denied");
            messages.push({ role: "tool", toolCallId: tc.id, content: msg });
            continue;
          }
        }
      }

      const result = await executeTool(tc);
      options.onToolResult?.(tc.name, result);

      const callKey = `${tc.name}:${JSON.stringify(tc.arguments)}`;
      const callCount = (seenCalls.get(callKey) || 0) + 1;
      seenCalls.set(callKey, callCount);

      if (result.error) {
        failedStreak++;
      } else {
        failedStreak = 0;
        warnedFailures = false;
      }

      if (result.error && errorReflector?.canRetry(tc.name, result.error)) {
        messages.push({ role: "tool", toolCallId: tc.id, content: `Error: ${result.error}` });
        messages.push({ role: "user", content: errorReflector.formatError(tc.name, result.error) });
        options.onRetry?.("retrying");
        errorReflector.resetTurn();
      } else {
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          content: result.error ? `Error: ${result.error}` : result.content,
        });
      }

      if (result.error && callCount >= 3 && !warnedRepeat) {
        messages.push({
          role: "system",
          content: `You have called ${tc.name} with identical arguments ${callCount} times. All calls failed with: ${result.error}. Change your approach.`,
        });
        warnedRepeat = true;
      } else if (result.error && callCount >= 4 && warnedRepeat) {
        options.onLoopDetected?.("loop detected");
        turnEnded = true;
        break;
      }

      if (failedStreak >= 5 && !warnedFailures) {
        messages.push({
          role: "system",
          content: "5 consecutive tool calls have failed. Review your approach before continuing.",
        });
        warnedFailures = true;
        turnEnded = true;
        break;
      }
    }

    if (diagnostics?.available) {
      const diagnosticErrors = await diagnostics.check();
      if (diagnosticErrors) {
        messages.push({
          role: "system",
          content: `Your last edit introduced these errors:\n\n${diagnosticErrors}`,
        });
        options.onDiagnostic?.("new errors detected");
      }
    }

    if (compactor && compactor.needsCompaction(messages)) {
      const persistedCount = options.sessionStore && options.sessionId
        ? await options.sessionStore.getMessageCount(options.sessionId)
        : 0;
      const before = messages.length;
      messages = await compactor.compact(messages);
      if (messages[0]?.role !== "system") {
        // Reinsert the stable preamble only — no volatile RepoMap/env here,
        // consistent with the per-turn path above (the next user turn will
        // carry fresh volatile context of its own).
        const rebuiltPrompt = getStablePreamble({
          mode: options.mode,
          workingDir: process.cwd(),
          skills: options.skills,
          memory: options.memory,
        });
        messages.unshift({ role: "system", content: rebuiltPrompt });
      }
      if (options.sessionStore && options.sessionId && persistedCount > 0) {
        const { summary, files } = compactor.getLastCompaction();
        const compactionSummary: CompactionSummary = {
          task: summary ?? "Conversation summarized.",
          decisions: [],
          files,
          errors_resolved: [],
        };
        await options.sessionStore.appendCompaction(
          options.sessionId,
          persistedCount - 1,
          compactionSummary,
        );
      }
      options.onCompacted?.(`${before} → ${messages.length} messages`);
    }
    } catch (err) {
      if (errorRecovery) {
        const msg = errorRecovery.handleFatalError(err instanceof Error ? err : new Error(String(err)));
        messages.push({ role: "system", content: msg });
        options.onDiagnostic?.(msg);
      } else {
        throw err;
      }
      break;
    }
  }

  if (turn >= maxTurns) {
    stopReason = "max_turns";
    options.onMaxTurns?.(messages);
  }

  return {
    messages,
    newMessages: messages.slice(newStart),
    stopReason,
  };
}
