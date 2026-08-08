import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { ToolDef, ToolOutput } from "../types.js";
import type { ToolHandler } from "./types.js";
import { ToolRegistry } from "./registry.js";

// Background jobs can produce unbounded output (dev servers, tail -f); holding
// it all in memory would leak. Each stream keeps the most recent 1MB and flags
// the truncation so check_job can say so.
const MAX_STREAM_CHARS = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_JOBS = 10;
const COMPLETED_JOB_TTL_MS = 5 * 60_000; // 5 minutes

export type JobStatus = "running" | "done" | "failed" | "killed";

export interface Job {
  id: string;
  command: string;
  proc: ChildProcess;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  status: JobStatus;
  exitCode: number | null;
  startTime: number;
  endTime: number | null;
  timeoutMs: number;
}

export interface JobStatusReport {
  id: string;
  command: string;
  status: JobStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  runningMs: number;
}

// Timeout handles live on the side (not on Job) so the plan's Job shape stays
// clean — they are bookkeeping, not job state.
const jobTimeouts = new WeakMap<Job, ReturnType<typeof setTimeout>>();

/**
 * Terminate the whole process tree. `detached: true` makes the spawned shell a
 * process-group leader (setsid on POSIX), so killing -pid reaches the shell and
 * every child it started — a plain proc.kill() would orphan grandchildren.
 * SIGTERM first, SIGKILL fallback for processes that ignore it.
 */
function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  const signalTree = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform === "win32") {
        proc.kill();
      } else {
        process.kill(-proc.pid!, signal);
      }
    } catch {
      // ESRCH: already exited. Nothing to kill.
      try { proc.kill(); } catch { /* already dead */ }
    }
  };
  signalTree("SIGTERM");
  const fallback = setTimeout(() => signalTree("SIGKILL"), 1500);
  fallback.unref();
}

/**
 * Module-level singleton (plan §3: "state survives across tool calls within a
 * session"). One CLI process runs one agent at a time, so a module singleton is
 * safe. A session resume loses the in-memory map — documented behavior: the OS
 * processes keep running, but job tracking does not survive a restart.
 */
export class JobManager {
  private jobs = new Map<string, Job>();

  start(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): { ok: true; id: string } | { ok: false; error: string } {
    // Make room first: drop completed jobs past the TTL, then enforce the cap.
    this.cleanup();
    const runningCount = [...this.jobs.values()].filter((j) => j.status === "running").length;
    if (runningCount >= MAX_JOBS) {
      return { ok: false, error: `Too many background jobs (max ${MAX_JOBS}). Wait for one to finish or kill it first.` };
    }
    if (!fs.existsSync(cwd)) {
      return { ok: false, error: `Working directory does not exist: ${cwd}` };
    }

    const id = randomUUID();
    let proc: ChildProcess;
    try {
      proc = spawn(command, {
        cwd,
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    const job: Job = {
      id,
      command,
      proc,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      status: "running",
      exitCode: null,
      startTime: Date.now(),
      endTime: null,
      timeoutMs,
    };
    this.jobs.set(id, job);

    proc.stdout?.on("data", (chunk: Buffer) => {
      job.stdout = appendCapped(job.stdout, chunk.toString(), () => { job.stdoutTruncated = true; });
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      job.stderr = appendCapped(job.stderr, chunk.toString(), () => { job.stderrTruncated = true; });
    });
    proc.on("error", (err) => {
      job.stderr += (job.stderr ? "\n" : "") + `[heirloom] failed to start: ${err.message}`;
      job.exitCode = -1;
      job.endTime = Date.now();
      if (job.status === "running") job.status = "failed";
      clearJobTimeout(job);
    });
    proc.on("exit", (code) => {
      job.exitCode = code;
      job.endTime = Date.now();
      if (job.status === "running") {
        job.status = code === 0 ? "done" : "failed";
      }
      clearJobTimeout(job);
    });

    const timeout = setTimeout(() => this.timeoutJob(id), timeoutMs);
    timeout.unref();
    jobTimeouts.set(job, timeout);

    return { ok: true, id };
  }

  check(jobId: string): JobStatusReport | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      id: job.id,
      command: job.command,
      status: job.status,
      exitCode: job.exitCode,
      stdout: job.stdout,
      stderr: job.stderr,
      stdoutTruncated: job.stdoutTruncated,
      stderrTruncated: job.stderrTruncated,
      runningMs: Date.now() - job.startTime,
    };
  }

  kill(jobId: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: `Unknown job: ${jobId}` };
    if (job.status !== "running") return { ok: true }; // no-op success, already finished
    job.status = "killed";
    job.endTime = Date.now();
    killTree(job.proc);
    clearJobTimeout(job);
    return { ok: true };
  }

  /** Kill every tracked job — used by tests and available for shutdown paths. */
  killAll(): void {
    for (const id of this.jobs.keys()) this.kill(id);
  }

  list(): Array<{ id: string; command: string; status: JobStatus; exitCode: number | null; runningMs: number }> {
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      command: j.command,
      status: j.status,
      exitCode: j.exitCode,
      runningMs: Date.now() - j.startTime,
    }));
  }

  /** Remove completed jobs older than 5 minutes (plan §3: auto-cleanup). */
  cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.status !== "running" && job.endTime !== null && now - job.endTime > COMPLETED_JOB_TTL_MS) {
        clearJobTimeout(job);
        this.jobs.delete(id);
      }
    }
  }

  private timeoutJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return;
    job.stderr += (job.stderr ? "\n" : "") + `[heirloom] timed out after ${job.timeoutMs}ms — process killed`;
    job.status = "failed";
    job.endTime = Date.now();
    killTree(job.proc);
  }
}

function appendCapped(buf: string, chunk: string, onTruncate: () => void): string {
  if (!chunk) return buf;
  let next = buf + chunk;
  if (next.length > MAX_STREAM_CHARS) {
    next = next.slice(-MAX_STREAM_CHARS);
    onTruncate();
  }
  return next;
}

function clearJobTimeout(job: Job): void {
  const t = jobTimeouts.get(job);
  if (t) {
    clearTimeout(t);
    jobTimeouts.delete(job);
  }
}

export const jobManager = new JobManager();

const runBackgroundHandler: ToolHandler = async (args, ctx) => {
  const command = args.command as string;
  if (typeof command !== "string" || command.trim() === "") {
    return { content: "", error: "Missing required argument: command" };
  }
  const cwd = (args.cwd as string) || ctx.workingDir || process.cwd();
  const timeoutMs = typeof args.timeout === "number" && args.timeout > 0
    ? Math.floor(args.timeout)
    : DEFAULT_TIMEOUT_MS;

  const result = jobManager.start(command, cwd, timeoutMs);
  if (!result.ok) return { content: "", error: result.error };
  return {
    content: [
      `Started background job ${result.id}`,
      `Command: ${command}`,
      `Use check_job with job_id "${result.id}" to poll status; kill_job to terminate.`,
    ].join("\n"),
  };
};

const checkJobHandler: ToolHandler = async (args) => {
  const jobId = args.job_id as string;
  if (typeof jobId !== "string" || jobId === "") {
    return { content: "", error: "Missing required argument: job_id" };
  }
  const report = jobManager.check(jobId);
  if (!report) {
    return { content: "", error: `Unknown job: ${jobId}. Job tracking is in-memory and does not survive a restart.` };
  }
  const lines = [
    `Status: ${report.status}${report.exitCode !== null ? ` (exit ${report.exitCode})` : ""}`,
    `Running for: ${(report.runningMs / 1000).toFixed(1)}s`,
  ];
  if (report.stdout) lines.push(`stdout:\n${report.stdout}`);
  else lines.push("stdout: (none)");
  if (report.stderr) lines.push(`stderr:\n${report.stderr}`);
  else lines.push("stderr: (none)");
  if (report.stdoutTruncated) lines.push("(stdout truncated — kept last 1MB)");
  if (report.stderrTruncated) lines.push("(stderr truncated — kept last 1MB)");
  return { content: lines.join("\n") };
};

const killJobHandler: ToolHandler = async (args) => {
  const jobId = args.job_id as string;
  if (typeof jobId !== "string" || jobId === "") {
    return { content: "", error: "Missing required argument: job_id" };
  }
  const result = jobManager.kill(jobId);
  if (!result.ok) return { content: "", error: result.error };
  const report = jobManager.check(jobId);
  return {
    content: report
      ? `Killed job ${jobId} (status: ${report.status}).`
      : `Killed job ${jobId}.`,
  };
};

const runBackgroundDef: ToolDef = {
  name: "run_bash_background",
  description: "Start a shell command in the background. Returns a job ID immediately; use check_job to poll status and read accumulated stdout/stderr, and kill_job to terminate it. For commands that run longer than the normal 120s run_bash timeout (dev servers, builds, tests).",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      cwd: { type: "string", description: "Working directory (optional, defaults to the project root)" },
      timeout: { type: "number", description: "Max runtime in milliseconds before the job is killed (optional, default 300000)" },
    },
    required: ["command"],
  },
};

const checkJobDef: ToolDef = {
  name: "check_job",
  description: "Check the status of a background job started with run_bash_background. Returns status (running/done/failed/killed), exit code, and accumulated stdout/stderr.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "The job ID returned by run_bash_background" },
    },
    required: ["job_id"],
  },
};

const killJobDef: ToolDef = {
  name: "kill_job",
  description: "Terminate a running background job started with run_bash_background (kills the whole process tree). No-op if the job already finished.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "The job ID returned by run_bash_background" },
    },
    required: ["job_id"],
  },
};

export function registerJobs(registry: ToolRegistry): void {
  registry.register({ def: runBackgroundDef, handler: runBackgroundHandler, groups: ["command"] });
  registry.register({ def: checkJobDef, handler: checkJobHandler, groups: ["command"] });
  registry.register({ def: killJobDef, handler: killJobHandler, groups: ["command"] });
}
