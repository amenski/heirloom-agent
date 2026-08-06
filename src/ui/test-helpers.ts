/**
 * Environment traps
 *
 * 1. ink-testing-library strips color regardless of theme — never assert ANSI
 *    escape sequences from its frames; assert visible shape instead (e.g.
 *    chips degrade to "[label]" without color).
 * 2. Its renderer does not repaint under timers — drive frames with
 *    rerender() or stdin writes plus flush waits; never compare frames
 *    across wall-clock sleeps.
 * 3. Real ink render() gates ANSI on is-in-ci (process.env.CI) + stdout.isTTY
 *    — when asserting bytes, pass interactive: true and a fake TTY stdout;
 *    always run the suite as `CI=true npm test` locally, because GitHub
 *    Actions sets CI=true.
 */

export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

export function fakeStdout() {
  const writes: string[] = [];
  const stream = {
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    isTTY: true,
    columns: 100,
    rows: 30,
    on() {}, off() {}, removeListener() {}, emit() {},
  };
  return { writes, stream: stream as unknown as NodeJS.WriteStream };
}
