import { exec } from "node:child_process";
import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler } from "./types.js";
import { ToolRegistry } from "./registry.js";

const searchHandler: ToolHandler = async (args) => {
  const pattern = args.pattern as string;
  const dir = (args.dir as string) || ".";

  return new Promise<ToolOutput>((resolve) => {
    exec(
      `grep -rn "${pattern}" "${dir}" 2>/dev/null | head -50`,
      { maxBuffer: 512 * 1024, timeout: 30_000 },
      (err, stdout) => resolve({ content: stdout || "No matches found." }),
    );
  });
};

const searchDef: ToolDef = {
  name: "search",
  description: "Search for a regex pattern in files under a directory using grep.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for" },
      dir: { type: "string", description: "Directory to search in (defaults to cwd)" },
    },
    required: ["pattern"],
  },
};

export function registerSearch(registry: ToolRegistry): void {
  registry.register({ def: searchDef, handler: searchHandler, groups: ["read"] });
}
