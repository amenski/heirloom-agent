import type { ToolDef } from "../types.js";
import type { ToolHandler } from "./types.js";
import type { ToolRegistry } from "./registry.js";

const attemptCompletionHandler: ToolHandler = async (args) => {
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!summary) {
    return { content: "Error: summary is required.", error: "Missing required argument: summary" };
  }
  // stop: true tells the agent loop to end the turn after this result.
  return { content: summary, stop: true };
};

const attemptCompletionDef: ToolDef = {
  name: "attempt_completion",
  description:
    "Signal that the task is complete and end the turn. Use only after verifying the requested work is done — the summary is the final word the user sees. This tool ends the agent's turn immediately.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "A concise summary of what was accomplished." },
    },
    required: ["summary"],
  },
};

export function registerAttemptCompletion(registry: ToolRegistry): void {
  registry.register({
    def: attemptCompletionDef,
    handler: attemptCompletionHandler,
    groups: ["read", "edit", "command", "mcp", "workflow"],
  });
}
