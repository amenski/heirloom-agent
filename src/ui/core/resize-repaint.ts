/**
 * Corrects Ink's frame repaint on terminal resize.
 *
 * The bug (ink 7.1, build/ink.js `resized`): Ink erases its previous frame
 * with `eraseLines(previousLineCount)`, where the count comes from splitting
 * its last output on "\n". When the terminal NARROWS, the terminal itself
 * re-wraps those already-printed lines onto MORE rows than that count, so
 * Ink's erase stops short and the top rows of the old frame survive — one
 * stranded copy of the input box per resize step.
 *
 * Approaches that do NOT work (all tried, all worse):
 * - Erasing the screen after Ink paints (from a React effect): wipes the fresh
 *   frame and desyncs Ink's cursor bookkeeping — later paints land misplaced.
 * - Erasing the screen before the resize commits: `\x1b[2J` also destroys the
 *   visible transcript, which is NOT in scrollback yet, and Ink never reprints
 *   <Static> content — the transcript simply vanishes.
 * - `inkInstance.clear()`: built for unmount; it re-syncs the output buffer so
 *   the next identical render is skipped, leaving a blank screen.
 *
 * The correct fix: replace Ink's resize listener with one that erases exactly
 * the number of rows the old frame occupies AFTER the terminal re-wrapped it —
 * computable from Ink's own last output string and the new column count — then
 * resets Ink's log bookkeeping and lets it repaint from scratch. The transcript
 * above the frame is never touched: terminals re-wrap plain printed text
 * natively, which was never the problem.
 *
 * Ink's `exports` map blocks bare deep imports of build/instances.js, so the
 * internals are resolved by file path next to Ink's own resolved entry point.
 * Everything is defensive: if any internal is missing (future Ink versions,
 * bundled copies), the stock Ink behavior is left untouched.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const CSI_OSC_PATTERN =
  // CSI sequences (colors, cursor movement) and OSC sequences (titles, links).
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(CSI_OSC_PATTERN, "");
}

// Rough wide-character check (CJK, Hangul, fullwidth forms): these occupy two
// terminal columns. Approximate — grapheme clusters and emoji ZWJ sequences are
// not fully modeled; an occasional off-by-one row is tolerable here because the
// erase only needs to cover the frame, and the frame is redrawn right after.
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(line: string): number {
  let width = 0;
  for (const ch of stripAnsi(line)) width += charWidth(ch.codePointAt(0)!);
  return width;
}

/**
 * How many terminal rows `frame` occupies once the terminal has re-wrapped it
 * at `columns`. Mirrors log-update's line accounting (split on "\n", every
 * entry costs at least one row — including a trailing empty one), then adds
 * the extra rows wrapping produces.
 */
export function computeRewrappedRows(frame: string, columns: number): number {
  const cols = Math.max(1, columns);
  let rows = 0;
  for (const line of frame.split("\n")) {
    rows += Math.max(1, Math.ceil(displayWidth(line) / cols));
  }
  return rows;
}

/** Same sequence ansi-escapes' eraseLines emits: erase each row moving up, end at column 1. */
export function buildEraseLines(count: number): string {
  if (count <= 0) return "";
  let out = "";
  for (let i = 0; i < count; i++) {
    out += "\x1b[2K" + (i < count - 1 ? "\x1b[1A" : "");
  }
  return out + "\x1b[G";
}

/**
 * Swap Ink's own resize listener for the corrected one. Call once, after
 * Ink's render() has created its instance for this stdout. Returns true when
 * the fix is installed; false leaves stock Ink behavior fully intact.
 */
export async function installResizeRepaintFix(
  stdout: NodeJS.WriteStream,
): Promise<boolean> {
  try {
    const require = createRequire(import.meta.url);
    // require.resolve("ink") honors the exports map → .../ink/build/index.js.
    // Siblings are then importable by absolute file URL (the exports map only
    // constrains bare specifiers).
    const entry = require.resolve("ink");
    const instancesUrl = pathToFileURL(entry.replace(/index\.js$/, "instances.js")).href;
    const domUrl = pathToFileURL(entry.replace(/index\.js$/, "dom.js")).href;

    const instances = (await import(instancesUrl)).default as
      | WeakMap<object, Record<string, unknown>>
      | undefined;
    const dom = await import(domUrl).catch(() => null);

    const inst = instances?.get(stdout) as
      | {
          resized?: () => void;
          log?: { reset?: () => void; clear?: () => void };
          throttledLog?: { cancel?: () => void };
          throttledOnRender?: { cancel?: () => void };
          lastOutput?: string;
          lastOutputToRender?: string;
          lastOutputHeight?: number;
          lastTerminalWidth?: number;
          rootNode?: unknown;
          calculateLayout?: () => void;
          onRender?: () => void;
        }
      | undefined;

    if (
      !inst ||
      typeof inst.resized !== "function" ||
      typeof inst.log?.reset !== "function" ||
      typeof inst.calculateLayout !== "function" ||
      typeof inst.onRender !== "function"
    ) {
      return false;
    }

    /** Erase the old frame's REWRAPPED footprint and zero Ink's bookkeeping. */
    const eraseFrameRewrapAware = () => {
      const columns = stdout.columns || 80;
      const previous = inst.lastOutputToRender || inst.lastOutput || "";
      if (previous !== "") {
        // The terminal re-wraps already-printed lines itself, with the cursor
        // kept on the frame's bottom row — erase exactly the rewrapped row
        // count upward, and no further (the transcript above must survive).
        stdout.write(buildEraseLines(computeRewrappedRows(previous, columns)));
      }
      inst.log!.reset!();
      inst.lastOutput = "";
      inst.lastOutputToRender = "";
      inst.lastOutputHeight = 0;
    };

    // Ink erases its frame with a wrap-naive row count in TWO places: the
    // resize handler, and log.clear() — which renderInteractiveFrame calls on
    // every <Static> flush (i.e. constantly while a turn streams). A resize
    // arriving between two streaming flushes leaves clear() under-erasing the
    // re-wrapped frame. Patch clear() itself to be wrap-aware so both paths
    // are covered.
    const originalClear = typeof inst.log.clear === "function" ? inst.log.clear.bind(inst.log) : undefined;
    inst.log.clear = () => {
      try {
        eraseFrameRewrapAware();
      } catch {
        originalClear?.();
      }
    };

    stdout.off("resize", inst.resized);

    const fixedResized = () => {
      try {
        // A throttled render/write scheduled BEFORE the resize would land on
        // the re-wrapped screen with pre-resize bookkeeping — cancel both.
        inst.throttledOnRender?.cancel?.();
        inst.throttledLog?.cancel?.();
        eraseFrameRewrapAware();
        inst.calculateLayout!();
        dom?.emitLayoutListeners?.(inst.rootNode);
        inst.onRender!();
        inst.lastTerminalWidth = stdout.columns || 80;
      } catch {
        // Any surprise → fall back to Ink's own handler for this event.
        inst.resized!();
      }
    };

    stdout.on("resize", fixedResized);
    return true;
  } catch {
    return false;
  }
}
