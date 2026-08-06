import { describe, it, expect } from "vitest";
import { parseDecrqmResponse } from "./terminal-probe.js";

describe("parseDecrqmResponse", () => {
  it("returns supported for a set (1) response", () => {
    expect(parseDecrqmResponse("\x1b[?2026;1$y")).toBe("supported");
  });

  it("returns supported for a reset (2) response", () => {
    expect(parseDecrqmResponse("\x1b[?2026;2$y")).toBe("supported");
  });

  it("returns unsupported for a not-recognized (0) response", () => {
    expect(parseDecrqmResponse("\x1b[?2026;0$y")).toBe("unsupported");
  });

  it("returns null for garbage input", () => {
    expect(parseDecrqmResponse("not an escape sequence at all")).toBeNull();
  });

  it("returns null for a partial prefix, then resolves once the full response accumulates", () => {
    const full = "\x1b[?2026;1$y";
    const partial = full.slice(0, 5);
    expect(parseDecrqmResponse(partial)).toBeNull();
    const accumulated = partial + full.slice(5);
    expect(parseDecrqmResponse(accumulated)).toBe("supported");
  });
});
