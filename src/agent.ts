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
import { buildSystemPrompt } from "./prompt.js";

export type ToolExecutor = (call: ToolCall) => Promise<ToolOutput>;

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
  onMaxTurns?: (messages: Message[]) => void;
}

export async function runAgent(
  userMessage: string,
  options: AgentOptions,
): Promise<Message[]> {
  const { provider, tools, executeTool, permissions, compactor, diagnostics, errorReflector, errorRecovery, maxTurns = 20 } = options;

  const systemPrompt = await buildSystemPrompt({
    mode: options.mode,
    workingDir: process.cwd(),
    skills: options.skills,
    repomap: options.repomap,
    memory: options.memory,
    conversation: userMessage,
  });

  let messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  let turn = 0;
  let turnEnded = false;
  while (turn < maxTurns && !turnEnded) {
    const seenCalls = new Map<string, number>();
    let failedStreak = 0;
    let warnedRepeat = false;
    let warnedFailures = false;

    try {
    turn++;
    errorReflector?.resetTurn();
    errorRecovery?.reset();

    let content = "";
    const pendingCalls: Map<string, { name: string; args: string }> = new Map();

    for await (const event of provider.streamChat(messages, tools)) {
      switch (event.type) {
        case "text_delta":
          content += event.content;
          process.stdout.write(event.content);
          break;
        case "tool_call_start":
          pendingCalls.set(event.id, { name: event.name, args: "" });
          break;
        case "tool_call_delta": {
          const entry = pendingCalls.get(event.id);
          if (entry) entry.args += event.arguments;
          break;
        }
        case "done":
          break;
      }
    }

    if (content) process.stdout.write("\n");

    if (pendingCalls.size === 0) break;

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
      console.log(`  [${tc.name}] ${JSON.stringify(tc.arguments).slice(0, 120)}`);

      if (permissions) {
        const action = permissions.check(tc.name, tc.arguments);
        if (action === "deny") {
          const msg = `Permission denied for ${tc.name}`;
          console.log("    denied");
          messages.push({ role: "tool", toolCallId: tc.id, content: msg });
          continue;
        }
      }

      const result = await executeTool(tc);

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
        console.log(`    [self-reflection: retrying]`);
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
        console.log("[loop detected: ending turn]");
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
        console.log(`  [diagnostics: new errors detected]`);
      }
    }

    console.log("");

    if (compactor && compactor.needsCompaction(messages)) {
      const before = messages.length;
      messages = await compactor.compact(messages);
      if (messages[0]?.role !== "system") {
        const convo = messages
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .filter(Boolean)
          .join("\n");
        const rebuiltPrompt = await buildSystemPrompt({
          mode: options.mode,
          workingDir: process.cwd(),
          skills: options.skills,
          repomap: options.repomap,
          memory: options.memory,
          conversation: convo,
        });
        messages.unshift({ role: "system", content: rebuiltPrompt });
      }
      console.log(`  [compacted: ${before} → ${messages.length} messages]`);
    }
    } catch (err) {
      if (errorRecovery) {
        const msg = errorRecovery.handleFatalError(err instanceof Error ? err : new Error(String(err)));
        messages.push({ role: "system", content: msg });
        console.log(`\n  [fatal: ${msg}]`);
      } else {
        throw err;
      }
      break;
    }
  }

  if (turn >= maxTurns) {
    if (options.onMaxTurns) {
      options.onMaxTurns(messages);
    }
    console.log("[max turns reached. Session saved.]");
  }

  return messages;
}
