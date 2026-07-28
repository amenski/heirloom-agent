import { exec } from "node:child_process";
import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler } from "./types.js";
import { ToolRegistry } from "./registry.js";

const runBashHandler: ToolHandler = async (args) => {
  const command = args.command as string;
  const cwd = (args.cwd as string) || process.cwd();

  return new Promise<ToolOutput>((resolve) => {
    exec(command, { cwd, timeout: 120_000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ content: `Exit code: ${err.code}\n${stdout}\n${stderr}` });
      } else {
        resolve({ content: stdout || "(no output)" });
      }
    });
  });
};

const runBashDef: ToolDef = {
  name: "run_bash",
  description: "Execute a shell command. Returns stdout and stderr.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      cwd: { type: "string", description: "Working directory (optional)" },
    },
    required: ["command"],
  },
};

export function registerBash(registry: ToolRegistry): void {
  registry.register({ def: runBashDef, handler: runBashHandler, groups: ["command"] });
}
