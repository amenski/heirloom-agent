import { execFile } from "node:child_process";
import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { wrapUntrusted, sanitizeControlChars } from "./untrusted-content.js";

const MAX_MATCH_LINES = 50;

const searchHandler: ToolHandler = async (args) => {
  const pattern = args.pattern as string;
  const dir = (args.dir as string) || ".";

  return new Promise<ToolOutput>((resolve) => {
    // execFile with shell:false (the default) passes pattern/dir as argv
    // entries — no shell parses them, so shell metacharacters in either
    // (", ;, $(...), backticks, ...) are inert literal bytes to grep, not
    // command syntax. This replaces the old `exec` shell-string pipeline
    // (grep ... 2>/dev/null | head -50), so stderr suppression and the
    // 50-line cap are reproduced in JS below instead of by the shell.
    execFile(
      "grep",
      ["-rn", pattern, dir],
      { maxBuffer: 512 * 1024, timeout: 30_000 },
      (err, stdout) => {
        // grep exits 1 for "no matches" — not a failure, same as the old
        // code's blanket ignore of `err`. Only a genuine failure (bad dir,
        // invalid pattern, exit code >= 2, signal kill, etc.) surfaces as an
        // error; content in that case still favors any stdout grep produced.
        const noMatches = (err as (Error & { code?: number }) | null)?.code === 1;
        if (err && !noMatches) {
          // The message can embed grep's stderr (e.g. a path from the
          // filesystem) — sanitize defensively, same rationale as the
          // content path below.
          const message = sanitizeControlChars((err as Error).message);
          resolve({ content: `Error running search: ${message}`, error: message });
          return;
        }
        if (!stdout) {
          resolve({ content: "No matches found." });
          return;
        }
        const capped = stdout.split("\n").slice(0, MAX_MATCH_LINES).join("\n");
        resolve({ content: wrapUntrusted(sanitizeControlChars(capped)) });
      },
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
