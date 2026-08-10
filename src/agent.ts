import type { Provider } from "./providers/types.js";
import type { Message, ToolCall, ToolDef, ToolOutput } from "./types.js";
import type { PermissionEngine } from "./permissions/index.js";
import type { ModeConfig } from "./modes/loader.js";
import type { Compactor } from "./compaction/compactor.js";
import type { DiagnosticRunner } from "./diagnostics/index.js";
import type { ErrorReflector } from "./selfreflection/index.js";
import type { ErrorRecovery } from "./errorrecovery/index.js";
import type { SkillDef } from "./skills/index.js";
import type { MemoryStore } from "./memory/store.js";
import type { SessionStore, CompactionSummary, PermissionDecision } from "./sessions/store.js";
import { buildStablePreamble, buildVolatileContext, type PromptContext } from "./prompt.js";
import { estimateTokens } from "./compaction/budget.js";

export type ToolExecutor = (call: ToolCall) => Promise<ToolOutput>;

import { extractToolSubject } from "./permissions/rules.js";

function permissionSubjectText(toolName: string, args: Record<string, unknown>): string {
  return extractToolSubject(toolName, args);
}

// Reporting threshold only, not a limit — large tool-call arguments (e.g. a
// big file write) are still parsed and executed in full. This just surfaces
// via onDiagnostic when JSON.parse is about to run on a large string, since
// that synchronous parse can stall the main thread long enough to look like
// a hang (spinner + elapsed clock both stalling).
const TOOL_ARGS_SIZE_DIAGNOSTIC_THRESHOLD = 256 * 1024; // 256KB

// Tools that carry no side-effects and are safe to execute in parallel. These
// match the "read" group in the tool registry. `ask_user_question` is excluded
// deliberately — it interacts with the user and must remain sequential.
const READ_TOOLS = new Set([
  "read_file", "list_files", "glob", "search", "docs_search", "web_fetch", "web_search",
]);

// Rebuilding the stable preamble is pure string concatenation, but it's still
// wasted work every turn when nothing it depends on has changed — and more
// importantly, recomputing it is how a would-be-stable prefix accidentally
// drifts. Cache it keyed on the primitive inputs that feed buildStablePreamble;
// reuse the previous string when they're unchanged (mode/skills are stable
// object references across turns, only reassigned on explicit mode/skill
// switches). One CLI process runs one agent loop at a time, so a module-level
// cache is safe here.
let stableCache: { mode?: ModeConfig; workingDir: string; skills?: SkillDef[]; memory?: string; repomap?: string; text: string } | undefined;

function getStablePreamble(ctx: PromptContext): string {
  if (
    stableCache &&
    stableCache.mode === ctx.mode &&
    stableCache.workingDir === ctx.workingDir &&
    stableCache.skills === ctx.skills &&
    stableCache.memory === ctx.memory &&
    stableCache.repomap === ctx.repomap
  ) {
    return stableCache.text;
  }
  const text = buildStablePreamble(ctx);
  stableCache = { mode: ctx.mode, workingDir: ctx.workingDir, skills: ctx.skills, memory: ctx.memory, repomap: ctx.repomap, text };
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
  /** Context-window ceiling used as budgetMax for per-turn token rows. Defaults to 128000, the codebase-wide fallback. */
  contextWindow?: number;
  skills?: SkillDef[];
  /** Precomputed session-stable repository-map snapshot (see buildRepoMap). */
  repomap?: string;
  /** Precomputed research-notes block (see loadProjectResearch). Plan-mode only. */
  research?: string;
  memory?: string;
  memoryStore?: MemoryStore;
  sessionStore?: SessionStore;
  sessionId?: string;
  signal?: AbortSignal;
  effort?: string;
  thinkingEnabled?: boolean;
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
  const { provider, tools, executeTool, permissions, compactor, diagnostics, errorReflector, errorRecovery, maxTurns = 100, effort, thinkingEnabled } = options;

  const promptCtx: PromptContext = {
    mode: options.mode,
    workingDir: process.cwd(),
    skills: options.skills,
    repomap: options.repomap,
    memory: options.memory,
    research: options.research,
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
  // One-shot guard for the empty-response retry below: a stream that ends with
  // no text, no reasoning, and no tool calls is a transient provider hiccup,
  // not a finished turn — retry once before giving up.
  let emptyResponseRetried = false;
  // Cross-turn dedup for ask_user_question: the model sometimes repeats the
  // same question in a later turn. Track the exact question+options key and
  // inject a system note if it's asked again — the note tells the model it
  // already asked and got an answer, preventing redundant prompts.
  const askedQuestions = new Set<string>();
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
    let turnTokens = 0;
    const pendingCalls: Map<string, { name: string; args: string }> = new Map();

    try {
    const requestMessages = volatileContext ? withVolatilePrefix(messages, volatileContext) : messages;
    for await (const event of provider.streamChat(requestMessages, tools, { signal: options.signal, effort, thinkingEnabled })) {
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
          turnTokens += event.inputTokens + event.outputTokens;
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
      // Provider stream failures (auth, HTTP, network) have deliberate handling
      // by the caller — headless surfaces them as a non-zero exit, the TUI shows
      // the error. errorRecovery.handleFatalError is for *unexpected* faults in
      // the rest of the turn body (tool loop, compaction, diagnostics), not for
      // these. Tag the error so the outer recovery catch re-throws it untouched.
      (err as any).__providerStreamError = true;
      throw err;
    }

    if (content) options.onText?.("\n");

    if (reasoning) messages.push({ role: "assistant", content: reasoning, meta: { asThinking: true } });

    // One token-usage row per turn: turnTokens is the provider-reported
    // input+output for this turn; totalUsed mirrors what compaction measures
    // (estimateTokens of the live message set) so remaining = budgetMax -
    // totalUsed agrees with the compaction headroom; budgetMax is the context
    // window. remaining is derived on read, never stored.
    const recordTokens = async (): Promise<void> => {
      if (!options.sessionStore || !options.sessionId) return;
      await options.sessionStore.appendToken(options.sessionId, {
        turnTokens,
        totalUsed: estimateTokens(messages),
        budgetMax: options.contextWindow ?? 128000,
      });
    };

    if (pendingCalls.size === 0) {
      if (!content && !reasoning) {
        if (!emptyResponseRetried) {
          emptyResponseRetried = true;
          options.onDiagnostic?.("empty response from provider — retrying once");
          continue;
        }
        options.onText?.("[empty response from provider]\n");
      }
      if (content) messages.push({ role: "assistant", content });
      await recordTokens();
      break;
    }

    const toolCalls: ToolCall[] = [];
    let retryWithCorrection = false;

    for (const [id, tc] of pendingCalls) {
      let args: Record<string, unknown> = {};
      if (tc.args.length > TOOL_ARGS_SIZE_DIAGNOSTIC_THRESHOLD) {
        options.onDiagnostic?.(`large tool call args (${tc.args.length} bytes) for ${tc.name}`);
      }
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

    await recordTokens();

    await diagnostics?.snapshot();

    // Fast path: when every tool call is a read-only operation with
    // pre-resolved allow/deny permissions (no askUser prompts), execute
    // them in parallel. Multi-file reads are the common case — without
    // this, three read_file calls take 3×RTT serially.
    const allReads = toolCalls.length > 1 &&
      toolCalls.every(tc => READ_TOOLS.has(tc.name));

    let tookParallelPath = false;

    if (allReads) {
      // Pre-resolve permissions: bail to sequential if any call needs askUser.
      let hasAsk = false;
      for (const tc of toolCalls) {
        if (permissions) {
          const { action } = permissions.resolve(tc.name, tc.arguments);
          if (action === "ask") { hasAsk = true; break; }
        }
      }

      if (!hasAsk) {
        tookParallelPath = true;

        // Fire all onToolStart at once so the UI sees the batch.
        for (const tc of toolCalls) {
          options.onToolStart?.(tc.name, tc.arguments);
        }

        // Handle denies first — no execution needed.
        for (const tc of toolCalls) {
          if (!permissions) continue;
          const { action } = permissions.resolve(tc.name, tc.arguments);
          if (action === "deny") {
            options.onDiagnostic?.("denied");
            messages.push({
              role: "tool",
              toolCallId: tc.id,
              content: `Permission denied for ${tc.name}`,
            });
          }
        }

        // Execute every allow call concurrently via Promise.allSettled.
        const toRun = toolCalls.filter(tc => {
          if (!permissions) return true;
          const { action } = permissions.resolve(tc.name, tc.arguments);
          return action !== "deny";
        });

        if (toRun.length > 0) {
          const results = await Promise.allSettled(
            toRun.map(tc => executeTool(tc)),
          );

          for (let i = 0; i < toRun.length; i++) {
            const tc = toRun[i];
            const r = results[i];
            const output: ToolOutput = r.status === "fulfilled"
              ? r.value
              : { content: "", error: (r.reason as Error)?.message ?? "Unknown error" };

            options.onToolResult?.(tc.name, output);

            const callKey = `${tc.name}:${JSON.stringify(tc.arguments)}`;
            seenCalls.set(callKey, (seenCalls.get(callKey) || 0) + 1);

            if (output.error) {
              failedStreak++;
            } else {
              failedStreak = 0;
            }

            messages.push({
              role: "tool",
              toolCallId: tc.id,
              content: output.error ? `Error: ${output.error}` : output.content,
            });
          }
        }
      }
    }

    if (!tookParallelPath) {
    for (const tc of toolCalls) {
      options.onToolStart?.(tc.name, tc.arguments);

      if (permissions) {
        const { action, winningRule, wasUnresolved } = permissions.resolve(tc.name, tc.arguments);
        const subject = permissionSubjectText(tc.name, tc.arguments);
        const audit = async (
          decision: PermissionDecision,
          reason: string,
        ): Promise<void> => {
          if (!options.sessionStore || !options.sessionId) return;
          await options.sessionStore.appendPermission(options.sessionId, {
            toolCallId: tc.id, tool: tc.name, subject, decision, winningRule, reason,
          });
        };

        if (action === "deny") {
          const msg = `Permission denied for ${tc.name}`;
          options.onDiagnostic?.("denied");
          await audit("deny-by-rule", `deny rule matched (${winningRule?.origin ?? "rule"})`);
          messages.push({ role: "tool", toolCallId: tc.id, content: msg });
          continue;
        }
        if (action === "ask") {
          if (options.askUser) {
            const allowed = await options.askUser(tc.name, tc.arguments);
            if (!allowed) {
              const msg = "PERMISSION_DENIED: denied by user";
              options.onDiagnostic?.("denied");
              await audit("ask-denied", "denied by user at prompt");
              messages.push({ role: "tool", toolCallId: tc.id, content: msg });
              continue;
            }
            // Approved via askUser. The TUI (App.tsx) writes a finer-grained
            // once/session/always row when it actually shows a prompt, but it
            // writes nothing when an auto-approve posture short-circuits the
            // prompt — so the agent records the coarse "approved" outcome here
            // to guarantee a row exists on every approval path. On the
            // interactive path this coexists with the UI's fine-grained row
            // (see UI-side approximation note in permission-spec.md).
            await audit(
              wasUnresolved ? "unresolved-ask" : "ask-approved",
              wasUnresolved
                ? "approved by user; bash segment was unresolved (fail-closed ask)"
                : "approved by user (or auto-approve posture)",
            );
          } else {
            const msg = "PERMISSION_DENIED: headless — rule resolved to ask";
            options.onDiagnostic?.("denied");
            await audit("headless-deny", "resolved to ask with no interactive prompter (headless)");
            messages.push({ role: "tool", toolCallId: tc.id, content: msg });
            continue;
          }
        } else if (action === "allow") {
          // Rule-derived allow with no prompt at all — still worth an audit
          // row so "why did this run without asking me" is answerable.
          await audit("allow-by-rule", `allow rule matched (${winningRule?.origin ?? "rule"})`);
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

      // Prevent the model from asking the same question again in a later turn.
      if (tc.name === "ask_user_question" && !result.error) {
        const qKey = JSON.stringify(tc.arguments);
        if (askedQuestions.has(qKey)) {
          messages.push({
            role: "system",
            content: "You already asked this exact question and received an answer. Do not ask it again.",
          });
        }
        askedQuestions.add(qKey);
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
          repomap: options.repomap,
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
      if (errorRecovery && !(err as any)?.__providerStreamError) {
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
