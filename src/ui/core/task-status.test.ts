import { describe, it, expect } from "vitest";
import { buildTaskSegments } from "./task-status.js";
import type { TaskRecord } from "../../orchestrator/runner.js";

const rec = (id: string, status: TaskRecord["status"]): TaskRecord => ({
  id,
  description: "d",
  status,
  spawnedAt: 0,
  depth: 0,
});

describe("buildTaskSegments (async-subagents.md §4 — status-line task segment)", () => {
  it("shows a single running task by id", () => {
    expect(buildTaskSegments([rec("task-1", "running")])).toEqual([
      { id: "tasks", text: "● task task-1 running", dimColor: true },
    ]);
  });

  it("collapses several running tasks to a count", () => {
    expect(buildTaskSegments([rec("task-1", "running"), rec("task-2", "running")])).toEqual([
      { id: "tasks", text: "● 2 tasks running", dimColor: true },
    ]);
  });

  it("renders nothing while no task runs — including all-terminal snapshots", () => {
    expect(buildTaskSegments([])).toEqual([]);
    expect(
      buildTaskSegments([rec("task-1", "done"), rec("task-2", "failed"), rec("task-3", "aborted")]),
    ).toEqual([]);
  });

  it("still shows the segment when other tasks are terminal", () => {
    expect(buildTaskSegments([rec("task-1", "done"), rec("task-2", "running")])).toEqual([
      { id: "tasks", text: "● task task-2 running", dimColor: true },
    ]);
  });
});
