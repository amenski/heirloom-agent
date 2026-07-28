import type { Provider } from "./providers/types.js";
import type { Message, ToolCall, ToolDef, ToolOutput } from "./types.js";
import type { PermissionEngine } from "./permissions/index.js";
import type { ModeConfig } from "./modes/loader.js";
import type { Compactor } from "./compaction/compactor.js";

function buildSystemPrompt(mode?: ModeConfig): string {
  if (mode) {
    let prompt = mode.roleDefinition;
    if (mode.customInstructions) {
      prompt += "\n\n" + mode.customInstructions;
    }
    return prompt;
  }

  return `You are heirloom, a helpful AI coding assistant. You have access to tools that let you read files, write files, run shell commands, list directories, and search code.

Rules:
- Use tools when you need to read, write, or discover information on the filesystem.
- Always use absolute paths.
- Be concise. Answer directly without unnecessary preamble.
- If you don't know something, say so rather than guessing.
- You can run bash commands but avoid destructive operations unless the user explicitly asks.`;
}

export type ToolExecutor = (call: ToolCall) => Promise<ToolOutput>;

export interface AgentOptions {
  provider: Provider;
  tools: ToolDef[];
  executeTool: ToolExecutor;
  permissions?: PermissionEngine;
  mode?: ModeConfig;
  compactor?: Compactor;
  maxTurns?: number;
}

export async function runAgent(
  userMessage: string,
  options: AgentOptions,
): Promise<Message[]> {
  const { provider, tools, executeTool, permissions, compactor, maxTurns = 20 } = options;

  let messages: Message[] = [
    { role: "system", content: buildSystemPrompt(options.mode) },
    { role: "user", content: userMessage },
  ];

  let turn = 0;
  while (turn < maxTurns) {
    turn++;

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
    for (const [id, tc] of pendingCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.args || "{}");
      } catch {
        args = { _raw: tc.args };
      }
      toolCalls.push({ id, name: tc.name, arguments: args });
    }

    messages.push({
      role: "assistant",
      content: content || null,
      toolCalls,
    });

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
      messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: result.error ? `Error: ${result.error}` : result.content,
      });
    }

    console.log("");

    if (compactor && compactor.needsCompaction(messages)) {
      const before = messages.length;
      messages = await compactor.compact(messages);
      if (messages[0]?.role !== "system") {
        messages.unshift({ role: "system", content: buildSystemPrompt(options.mode) });
      }
      console.log(`  [compacted: ${before} → ${messages.length} messages]`);
    }
  }

  return messages;
}
