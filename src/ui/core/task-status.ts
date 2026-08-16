import type { TaskRecord } from "../../orchestrator/runner.js";
import type { StatusSegment } from "../types.js";

/**
 * Status-line segments for async sub-runs (async-subagents.md §4): while any
 * task runs, the row shows `● task <id> running` (or `N tasks` when several);
 * with none running, no segment. Pure — the caller (cli.tsx buildStatusBar)
 * feeds the live registry snapshot, so the segment appears and clears with
 * registry state.
 */
export function buildTaskSegments(tasks: TaskRecord[]): StatusSegment[] {
  const running = tasks.filter((t) => t.status === "running");
  if (running.length === 1) {
    return [{ id: "tasks", text: `● task ${running[0].id} running`, dimColor: true }];
  }
  if (running.length > 1) {
    return [{ id: "tasks", text: `● ${running.length} tasks running`, dimColor: true }];
  }
  return [];
}
