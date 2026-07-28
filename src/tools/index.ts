import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { ToolCall, ToolOutput, ToolDef } from "../types.js";

const TOOLS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {};

TOOLS.read_file = async (args) => {
  const path = args.path as string;
  try {
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").slice(0, 2000);
    let result = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
    if (lines.length >= 2000) result += "\n(file truncated at 2000 lines)";
    return result;
  } catch (err: unknown) {
    return `Error reading file: ${(err as Error).message}`;
  }
};

TOOLS.write_file = async (args) => {
  const path = args.path as string;
  const content = args.content as string;
  try {
    await writeFile(path, content, "utf-8");
    return `Wrote ${content.split("\n").length} lines to ${path}`;
  } catch (err: unknown) {
    return `Error writing file: ${(err as Error).message}`;
  }
};

TOOLS.run_bash = async (args) => {
  const command = args.command as string;
  const cwd = (args.cwd as string) || process.cwd();
  return new Promise<string>((resolve) => {
    exec(command, { cwd, timeout: 120_000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve(`Exit code: ${err.code}\n${stdout}\n${stderr}`);
      } else {
        resolve(stdout || "(no output)");
      }
    });
  });
};

TOOLS.list_files = async (args) => {
  const path = (args.path as string) || ".";
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => `${e.isDirectory() ? "dir" : "file"}  ${e.name}`).join("\n");
  } catch (err: unknown) {
    return `Error listing directory: ${(err as Error).message}`;
  }
};

TOOLS.search = async (args) => {
  const pattern = args.pattern as string;
  const dir = (args.dir as string) || ".";
  return new Promise<string>((resolve) => {
    exec(
      `grep -rn "${pattern}" "${dir}" 2>/dev/null | head -50`,
      { maxBuffer: 512 * 1024, timeout: 30_000 },
      (err, stdout) => resolve(stdout || "No matches found."),
    );
  });
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "read_file",
    description: "Read a file from the filesystem. Returns content with line numbers.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute file path" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Overwrites if it exists.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
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
  },
  {
    name: "list_files",
    description: "List files and directories in a given path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path (defaults to cwd)" } },
      required: [],
    },
  },
  {
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
  },
];

export async function executeTool(call: ToolCall): Promise<ToolOutput> {
  const handler = TOOLS[call.name];
  if (!handler) {
    return { content: `Unknown tool: ${call.name}`, error: `Unknown tool: ${call.name}` };
  }
  const result = await handler(call.arguments);
  return { content: result };
}
