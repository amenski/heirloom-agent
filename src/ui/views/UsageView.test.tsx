import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import UsageView from "./UsageView.js";
import type { ProviderBalance } from "../../providers/types.js";
import { __resetInputWireForTests } from "../hooks/useTerminalInput.js";
import { stripAnsi } from "../test-helpers.js";

const ESC = "\x1b";

// useTerminalInput keeps ONE module-level stdin listener for the process, so a
// component left mounted from a previous test keeps ownership of the wire and
// the next render's keys go nowhere. Unmount and reset between tests.
const mounted: Array<{ unmount: () => void }> = [];
const flush = () => new Promise((r) => setTimeout(r, 60));

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  __resetInputWireForTests();
});

const BALANCE: ProviderBalance = { currency: "USD", total: 1.25, granted: 0.1 };

function setup(opts: {
  getBalance?: () => Promise<ProviderBalance | null>;
  modelUsage?: Record<string, { input: number; output: number; cached: number }>;
  onClose?: () => void;
} = {}) {
  const inst = render(
    <UsageView
      providerName="deepseek"
      getBalance={opts.getBalance ?? (async () => BALANCE)}
      modelUsage={opts.modelUsage ?? { "deepseek/deepseek-v4-pro": { input: 1234, output: 567, cached: 89 } }}
      sessionInput={1234}
      sessionOutput={567}
      onClose={opts.onClose ?? vi.fn()}
      width={80}
    />,
  );
  mounted.push(inst);
  return inst;
}

describe("UsageView", () => {
  it("renders the balance block (currency, total, granted, remaining) when getBalance returns a value", async () => {
    const { lastFrame } = setup();
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Usage");
    expect(frame).toContain("deepseek");
    expect(frame).toContain("Currency   USD");
    expect(frame).toContain("Total      $1.25");
    expect(frame).toContain("Granted    $0.10");
    expect(frame).toContain("Remaining  $1.15");
  });

  it("renders the not-supported block when getBalance returns null", async () => {
    const { lastFrame } = setup({ getBalance: async () => null });
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Balance not supported for deepseek.");
    expect(frame).not.toContain("$1.25");
  });

  it("renders the per-model token breakdown and session totals", async () => {
    const { lastFrame } = setup();
    await flush();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("deepseek/deepseek-v4-pro: 1,234 in / 567 out / 89 cached");
    expect(frame).toContain("Session total: 1.2k in / 0.6k out");
  });

  it("renders a placeholder when no token records exist", async () => {
    const { lastFrame } = setup({ modelUsage: {} });
    await flush();
    expect(stripAnsi(lastFrame() ?? "")).toContain("No token usage recorded yet this session.");
  });

  it("queries the balance exactly once per open (live query, no caching)", async () => {
    const getBalance = vi.fn(async () => BALANCE);
    const inst = setup({ getBalance });
    await flush();
    expect(getBalance).toHaveBeenCalledTimes(1);
    // A re-render while open must not re-fetch.
    inst.rerender(<UsageView
      providerName="deepseek"
      getBalance={getBalance}
      modelUsage={{ "deepseek/deepseek-v4-pro": { input: 1234, output: 567, cached: 89 } }}
      sessionInput={1234}
      sessionOutput={567}
      onClose={vi.fn()}
      width={80}
    />);
    await flush();
    expect(getBalance).toHaveBeenCalledTimes(1);
  });

  it("Esc closes", async () => {
    const onClose = vi.fn();
    const { stdin } = setup({ onClose });
    stdin.write(ESC);
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
