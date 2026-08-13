import { spawn, type ChildProcess } from "node:child_process";
import type { ToolOutput, ToolDef } from "../types.js";
import type { ToolHandler } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { jobManager, killTree, appendCapped, DEFAULT_TIMEOUT_MS } from "./jobs.js";

const RUN_BASH_TIMEOUT_MS = 120_000;
// run_bash keeps the most recent 512KB of output (the old exec maxBuffer
// contract); on overflow the tail is kept and a note is added instead of
// killing the process.
const MAX_BASH_OUTPUT_CHARS = 512 * 1024;

// Commands that look interactive — editors, pagers, monitors, and stdin-driven
// CLIs (git credential prompts, psql/mysql/sqlite3, sleep) — are killed on
// timeout instead of migrated to the background, where they would sit as a job
// waiting on input that never arrives. Bare shells and REPLs (bash, node,
// python…) kill only when invoked with no script operand: `node server.js` is
// a dev server and migrates like any other command, `node` is a REPL.
const ALWAYS_INTERACTIVE = new Set([
  "vim", "vi", "nano", "emacs", "less", "more", "htop", "top", "man", "watch",
  "psql", "mysql", "sqlite3", "git", "sleep",
]);
const REPLS = new Set([
  "bash", "sh", "zsh", "fish", "node", "python", "python3", "ipython", "irb", "bc",
]);

function looksInteractive(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const first = tokens[0] ?? "";
  if (ALWAYS_INTERACTIVE.has(first)) return true;
  if (REPLS.has(first)) {
    const hasOperand = tokens.slice(1).some((t) => !t.startsWith("-"));
    return !hasOperand;
  }
  return false;
}

/**
 * commands.timeoutToBackground (plan §3, decision D — default ON): when
 * run_bash hits its timeout cap, move the process to JobManager instead of
 * killing it. `undefined` (key absent) means the default — ON.
 */
export function resolveTimeoutToBackground(v: boolean | undefined): boolean {
  return v !== false;
}

/**
 * Run a command with an explicit timeout, accumulating capped output. When the
 * timeout fires with `timeoutToBackground` true and the command does not look
 * interactive, the child is handed to JobManager instead of killed, and the
 * result tells the model to poll check_job. Exported for tests — the
 * registered handler passes the config-derived flag and the fixed 120s cap.
 */
export function runBashTimed(
  command: string,
  cwd: string,
  timeoutMs: number,
  timeoutToBackground: boolean,
): Promise<ToolOutput> {
  let proc: ChildProcess;
  try {
    proc = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return Promise.resolve({ content: `Exit code: -1\nFailed to start: ${(err as Error).message}` });
  }

  return new Promise<ToolOutput>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const truncationNote = () =>
      stdoutTruncated || stderrTruncated ? "\n(output truncated — kept last 512KB)" : "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout = appendCapped(stdout, chunk.toString(), () => { stdoutTruncated = true; }, MAX_BASH_OUTPUT_CHARS);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderr = appendCapped(stderr, chunk.toString(), () => { stderrTruncated = true; }, MAX_BASH_OUTPUT_CHARS);
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ content: `Exit code: -1\nFailed to start: ${(err as Error).message}` });
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ content: `${stdout || "(no output)"}${truncationNote()}` });
      } else {
        resolve({ content: `Exit code: ${code}\n${stdout}\n${stderr}${truncationNote()}` });
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (timeoutToBackground && !looksInteractive(command)) {
        // The child keeps running; JobManager takes over its streams and the
        // model polls check_job for the rest of the output.
        const adopted = jobManager.adopt(proc, {
          command,
          cwd,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          stdout,
          stderr,
        });
        if (adopted.ok) {
          resolve({
            content: `Command exceeded ${Math.ceil(timeoutMs / 1000)}s timeout — moved to background as job ${adopted.id}. Use check_job with job_id "${adopted.id}" to poll status and output; kill_job to terminate it.`,
          });
          return;
        }
        // Adoption failed (job cap) — fall through to the kill path.
      }
      killTree(proc);
      // Same shape the old exec-based handler produced on a timeout kill.
      resolve({ content: `Exit code: null\n${stdout}\n${stderr}` });
    }, timeoutMs);
  });
}

const runBashHandler: ToolHandler = async (args, ctx) => {
  const command = args.command as string;
  const cwd = (args.cwd as string) || ctx.workingDir || process.cwd();
  return runBashTimed(command, cwd, RUN_BASH_TIMEOUT_MS, resolveTimeoutToBackground(ctx.timeoutToBackground));
};

const runBashDef: ToolDef = {
  name: "run_bash",
  description: "Execute a shell command. Returns stdout and stderr. Commands that exceed the 120s timeout are moved to the background and return a job id to poll with check_job (unless they look interactive, e.g. editors/sleep, or timeoutToBackground is disabled).",
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
