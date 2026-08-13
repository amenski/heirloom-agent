import type { Provider } from "../providers/types.js";
import type { Message, ToolCall, ToolDef, ToolOutput } from "../types.js";
import type { ToolHandler, ToolContext } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { runAgent } from "../agent.js";
import { Compactor } from "../compaction/compactor.js";
import { ModeLoader } from "../modes/loader.js";
import type { PermissionEngine, ProfileEvaluator } from "../permissions/index.js";
import type { HookRunner } from "../hooks/index.js";
import { subagentAuditStore } from "../sessions/store.js";
import { TodoStore } from "../tools/todo.js";

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
  /**
   * Provider factory resolved at sub-agent spawn time, so a sub-agent always
   * uses the provider/model the parent session is currently on (including
   * mid-session `/model` switches) instead of the provider captured at
   * tool-registration time.
   */
  provider: () => Provider;
  registry: ToolRegistry;
  modeLoader: ModeLoader;
  permissions?: PermissionEngine;
  /**
   * The parent session's capability-boundary gate (permission-profile.md §6):
   * sub-agents inherit the profile together with the rule engine — same
   * object threading as today's permission inheritance, so a sub-agent can
   * never reach beyond what the parent may reach.
   */
  profile?: ProfileEvaluator;
  /**
   * Surfaces a sub-agent's ask-tier permission calls to the same prompt flow
   * the top-level agent uses, instead of auto-denying them. Without this,
   * a sub-agent spawned while the parent UI is mid-session gets
   * PERMISSION_DENIED on every ask-tier action it attempts, since agent.ts's
   * headless branch (no askUser) denies rather than asks.
   */
  askUser?: (toolName: string, args: Record<string, unknown>) => Promise<boolean | "posture">;
  /**
   * Resolved at sub-agent spawn time. Lets Esc/Ctrl+C at the top level abort
   * an in-flight sub-agent instead of leaving it running to completion.
   */
  getSignal?: () => AbortSignal | undefined;
  /** Lifecycle hooks dispatcher (docs/hooks-spec.md) — SubagentStart/Stop
   *  fire around each sub-agent run. */
  hooks?: HookRunner;
  maxDepth?: number;
  maxSubTurns?: number;
}

export class Orchestrator {
  private options: Required<Pick<OrchestratorOptions, "maxDepth" | "maxSubTurns">> & {
    provider: () => Provider;
    registry: ToolRegistry;
    modeLoader: ModeLoader;
    permissions?: PermissionEngine;
    profile?: ProfileEvaluator;
    getSignal?: () => AbortSignal | undefined;
    hooks?: HookRunner;
  };
  private askUser?: (toolName: string, args: Record<string, unknown>) => Promise<boolean | "posture">;

  constructor(options: OrchestratorOptions) {
    this.options = {
      maxDepth: 3,
      maxSubTurns: 10,
      ...options,
    };
    this.askUser = options.askUser;
  }

  /**
   * Re-point the askUser callback. The interactive CLI's prompt bridge is
   * recreated every turn, so the orchestrator (registered once at startup)
   * must be told about the current turn's bridge rather than holding a stale
   * closure. Headless mode leaves this unset, which auto-denies.
   */
  setAskUser(askUser: ((toolName: string, args: Record<string, unknown>) => Promise<boolean | "posture">) | undefined): void {
    this.askUser = askUser;
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

      const provider = this.options.provider();
      const subCompactor = new Compactor(provider);

      // The sub-agent gets its own todo store: its update_todo_list calls must
      // not clobber the parent's checklist panel, and its own model context
      // should see its own plan (getTodos below). The store is threaded
      // explicitly through each per-call tool context below — no shared
      // global pointer is mutated — so nested sub-runs isolate purely by
      // context, and a tool call can never see another run's store.
      const subStore = new TodoStore();

      // Decision H (feature-plans.md §10): the sub-agent's permission and
      // token rows land in the PARENT session's JSONL, tagged
      // `source: "subagent"`, through a restricted audit-only view of the
      // parent's store. Messages and todo snapshots can never pass through
      // the view, so the parent transcript stays clean and todoStore
      // isolation is unchanged. When the parent itself has no store wired
      // (headless run), there is nothing to audit into and the sub-agent
      // stays audit-silent, exactly like the parent.
      const subAuditStore = ctx.sessionStore ? subagentAuditStore(ctx.sessionStore) : undefined;

      const subExecuteTool = (call: ToolCall): Promise<ToolOutput> => {
        if (call.name === "new_task") {
          return this.createHandler(depth + 1)(call.arguments, { ...ctx, todoStore: subStore, sessionStore: subAuditStore });
        }
        // sessionStore: subAuditStore — only permission/token rows may pass
        // through to the parent session; sub-agent plans stay ephemeral.
        return this.options.registry.execute(call, { ...ctx, todoStore: subStore, sessionStore: subAuditStore });
      };

      // SubagentStart/SubagentStop fire around the actual spawn (hooks-spec.md
      // §2); depth/mode failures above never spawn anything, so no hooks fire.
      await this.options.hooks?.dispatch("SubagentStart", { task: description });
      try {
        const result = await runAgent(description, {
          provider,
          tools: subTools,
          executeTool: subExecuteTool,
          compactor: subCompactor,
          permissions: this.options.permissions,
          permissionProfile: this.options.profile,
          askUser: this.askUser,
          maxTurns: this.options.maxSubTurns,
          mode: subMode,
          hooks: this.options.hooks,
          // Parent session identity behind the audit-only view: permission
          // and token rows land in the parent's JSONL tagged "subagent";
          // every other write is blocked by the view (subsystems.md §7).
          sessionStore: subAuditStore,
          sessionId: ctx.sessionId,
          signal: this.options.getSignal?.(),
          getTodos: () => subStore.getTodos(),
        });

        const summary = summarizeMessages(result.messages, description);
        return { content: summary };
      } catch (err) {
        return {
          content: `Sub-task failed after error: ${(err as Error).message}`,
          error: `SUBTASK_ERROR: ${(err as Error).message}`,
        };
      } finally {
        await this.options.hooks?.dispatch("SubagentStop", { task: description });
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
