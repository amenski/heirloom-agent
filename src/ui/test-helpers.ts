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
 * 4. ink-testing-library's <Static> does NOT behave like a real terminal's
 *    Static flush for the purposes of `frames`/`lastFrame()`. Empirically
 *    probed (see the OutputArea <Static> migration): every frame in `frames`
 *    is a full composite snapshot containing BOTH the Static items rendered
 *    so far AND the current live content, on every render — there is no
 *    frame that holds only-static or only-live content, and content is never
 *    duplicated across frames. So containment assertions against
 *    `lastFrame()` keep working unchanged after switching a component to
 *    <Static>. The trap is only for assertions that need a specific
 *    Static-vs-live SPLIT (e.g. "the live tail alone must not contain X") —
 *    those must inspect a single frame's full text, never diff/concatenate
 *    across frames.
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
