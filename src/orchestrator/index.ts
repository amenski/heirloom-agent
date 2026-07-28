import type { Provider } from "../providers/types.js";
import type { Message, ToolCall, ToolDef, ToolOutput } from "../types.js";
import type { ToolHandler, ToolContext } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { runAgent } from "../agent.js";
import { Compactor } from "../compaction/compactor.js";
import { ModeLoader } from "../modes/loader.js";

const NEW_TASK_DEF: ToolDef = {
  name: "new_task",
  description:
    "Spawn a sub-agent to handle a discrete, isolated task. The sub-agent runs in a " +
    "fresh context with its own message history and tool access. When it completes, you " +
    "receive a summary of what was done — you do not see raw file diffs or tool outputs " +
    "from the sub-agent.\n\n" +
    "Use this to delegate implementation work, research, or analysis to a specialized " +
    "mode. Each sub-agent can itself spawn sub-agents up to a maximum depth of 3.",
  parameters: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description:
          "A clear, self-contained description of what the sub-agent should accomplish. " +
          "Include all necessary context since the sub-agent cannot see your conversation.",
      },
      mode: {
        type: "string",
        description:
          "The mode to run the sub-agent in. Available: 'code' (implementation), " +
          "'architect' (planning/design), 'debug' (investigation), 'ask' (research). " +
          "Defaults to 'code'.",
      },
    },
    required: ["description"],
  },
};

export interface OrchestratorOptions {
  provider: Provider;
  registry: ToolRegistry;
  executeTool: (call: ToolCall) => Promise<ToolOutput>;
  modeLoader: ModeLoader;
  maxDepth?: number;
  maxSubTurns?: number;
}

export class Orchestrator {
  private options: Required<
    Pick<OrchestratorOptions, "maxDepth" | "maxSubTurns">
  > & {
    provider: Provider;
    registry: ToolRegistry;
    executeTool: (call: ToolCall) => Promise<ToolOutput>;
    modeLoader: ModeLoader;
  };

  constructor(options: OrchestratorOptions) {
    this.options = {
      maxDepth: 3,
      maxSubTurns: 10,
      ...options,
    };
  }

  register(registry: ToolRegistry): void {
    registry.register({
      def: NEW_TASK_DEF,
      handler: this.createHandler(0),
      groups: ["workflow"],
    });
  }

  private createHandler(depth: number): ToolHandler {
    return async (
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolOutput> => {
      if (depth >= this.options.maxDepth) {
        return {
          content: `Maximum task nesting depth reached (${this.options.maxDepth}). Cannot spawn further sub-tasks.`,
          error: "MAX_DEPTH",
        };
      }

      const description = args.description as string;
      const modeSlug = (args.mode as string) || "code";

      const subMode = await this.options.modeLoader.load(modeSlug);
      if (!subMode) {
        return {
          content: `Unknown mode: "${modeSlug}". Available built-in modes: code, architect, debug, ask, orchestrator.`,
          error: "UNKNOWN_MODE",
        };
      }

      const subModeGroups = subMode.groups || [];
      const subTools: ToolDef[] = [
        ...this.options.registry.getByMode(subModeGroups),
        NEW_TASK_DEF,
      ];

      const subCompactor = new Compactor(this.options.provider);

      const subExecuteTool = (call: ToolCall): Promise<ToolOutput> => {
        if (call.name === "new_task") {
          return this.createHandler(depth + 1)(call.arguments, ctx);
        }
        return this.options.executeTool(call);
      };

      try {
        const messages = await runAgent(description, {
          provider: this.options.provider,
          tools: subTools,
          executeTool: subExecuteTool,
          compactor: subCompactor,
          maxTurns: this.options.maxSubTurns,
          mode: subMode,
        });

        const summary = summarizeMessages(messages, description);
        return { content: summary };
      } catch (err) {
        return {
          content: `Sub-task failed after error: ${(err as Error).message}`,
          error: `SUBTASK_ERROR: ${(err as Error).message}`,
        };
      }
    };
  }
}

function summarizeMessages(messages: Message[], task: string): string {
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.content;

  const toolCount = messages.filter((m) => m.role === "tool").length;

  const parts: string[] = [];
  parts.push(`**Task**: ${task}`);
  parts.push(`**Tools executed**: ${toolCount}`);

  if (lastAssistant) {
    parts.push(`**Result**: ${lastAssistant.slice(0, 500)}`);
  } else {
    parts.push(`**Result**: completed (no final message from sub-agent)`);
  }

  return parts.join("\n");
}
