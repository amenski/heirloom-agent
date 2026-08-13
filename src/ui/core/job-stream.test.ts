import { describe, it, expect, vi } from "vitest";
import { JobOutputCoalescer } from "./job-stream.js";

describe("JobOutputCoalescer", () => {
  it("joins pushed chunks into a single flush", () => {
    const emit = vi.fn();
    const c = new JobOutputCoalescer(emit);
    c.push("server ");
    c.push("listening\n");
    c.push("on :3000\n");
    c.flush();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("server listening\non :3000\n");
  });

  it("emits nothing on an empty flush and drops empty chunks", () => {
    const emit = vi.fn();
    const c = new JobOutputCoalescer(emit);
    c.flush();
    c.push("");
    c.flush();
    expect(emit).not.toHaveBeenCalled();
  });

  it("flushes repeatedly (one emit per flush) and hasPending tracks buffered chunks", () => {
    const emit = vi.fn();
    const c = new JobOutputCoalescer(emit);
    expect(c.hasPending).toBe(false);
    c.push("a");
    expect(c.hasPending).toBe(true);
    c.flush();
    expect(c.hasPending).toBe(false);
    c.push("b");
    c.flush();
    expect(emit.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
  });
});
