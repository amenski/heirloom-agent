import { useLayoutEffect, useRef } from "react";
import { useStdin } from "ink";
import { enableBracketedPaste, disableBracketedPaste } from "../Accessibility.js";

export interface InputKey {
  key: string;
  value: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  backspace: boolean;
  delete: boolean;
  tab: boolean;
  return: boolean;
  escape: boolean;
  home: boolean;
  end: boolean;
  pageUp: boolean;
  pageDown: boolean;
  paste?: string;
}

const EMPTY_KEY: InputKey = {
  key: "", value: "", ctrl: false, shift: false, meta: false,
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  backspace: false, delete: false, tab: false, return: false,
  escape: false, home: false, end: false, pageUp: false, pageDown: false,
};

function makeKey(key: string, overrides: Partial<InputKey> = {}): InputKey {
  return { ...EMPTY_KEY, key, value: key, ...overrides };
}

function applyMod(ek: InputKey, b: number): InputKey {
  ek.shift = (b & 1) !== 0;
  ek.meta = (b & 2) !== 0;
  ek.ctrl = (b & 4) !== 0;
  return ek;
}

function parseCsi(buf: string, offset: number): [InputKey, number] | null {
  if (offset >= buf.length) return null;
  let i = offset;
  const params: number[] = [];
  let currentNum = "";

  while (i < buf.length) {
    const ch = buf[i];
    if (ch >= "0" && ch <= "9") {
      currentNum += ch;
      i++;
      continue;
    }
    if (ch === ";") {
      params.push(currentNum ? parseInt(currentNum, 10) : 0);
      currentNum = "";
      i++;
      continue;
    }
    if (ch === "~") {
      params.push(currentNum ? parseInt(currentNum, 10) : 0);
      const p1 = params[0] || 0;
      if (p1 === 2) return [makeKey("", { home: true }), i + 1];
      if (p1 === 3) return [makeKey("", { delete: true }), i + 1];
      if (p1 === 5) return [makeKey("", { pageUp: true }), i + 1];
      if (p1 === 6) return [makeKey("", { pageDown: true }), i + 1];
      if (p1 === 7) return [makeKey("", { home: true }), i + 1];
      if (p1 === 8) return [makeKey("", { end: true }), i + 1];
      return null;
    }
    // The terminating letter ends whatever digit group was still accumulating
    // (e.g. the "3" in "1;3D", a modifier parameter) — only ";" pushed
    // completed groups into `params` above, so without this the modifier
    // param was silently dropped and modified arrows (Option+Left, etc.)
    // never carried their modifier bits.
    if (currentNum) { params.push(parseInt(currentNum, 10)); currentNum = ""; }
    const p1 = params[0] || 0;
    const p2 = params[1] || 0;
    const mod = p2 > 0 ? p2 - 1 : 0;

    if (ch === "A") return [applyMod(makeKey("", { upArrow: true }), mod), i + 1];
    if (ch === "B") return [applyMod(makeKey("", { downArrow: true }), mod), i + 1];
    if (ch === "C") return [applyMod(makeKey("", { rightArrow: true }), mod), i + 1];
    if (ch === "D") return [applyMod(makeKey("", { leftArrow: true }), mod), i + 1];
    if (ch === "H") return [applyMod(makeKey("", { home: true }), mod), i + 1];
    if (ch === "F") return [applyMod(makeKey("", { end: true }), mod), i + 1];
    if (ch === "Z") return [makeKey("", { tab: true, shift: true }), i + 1];
    return null;
  }
  return null;
}

function parseOseq(buf: string, offset: number): [InputKey, number] | null {
  if (offset + 1 >= buf.length) return null;
  const ch = buf[offset + 1];
  // A/B/C/D: SS3-encoded arrow keys. Terminals in application-cursor-key mode
  // (DECCKM, set via `ESC[?1h`) send arrows as `ESC O A/B/C/D` instead of the
  // normal CSI `ESC[A/B/C/D` — JediTerm (IntelliJ's terminal) and others do
  // this. Before this map had these entries, SS3 arrows fell through to the
  // bare "\x1b" → escape branch below, plus the trailing O/letter leaked in
  // as stray printable characters. Since `escape` drives interrupt/dismiss
  // behavior throughout the UI, that meant every arrow keypress in these
  // terminals closed menus or interrupted the current turn instead of just
  // silently failing to navigate.
  // Modified SS3 arrows (e.g. shift+up) are not handled here: unlike CSI,
  // which encodes modifiers as `ESC[1;5A`, SS3 has no standard modifier
  // parameter slot, and terminals that support modified arrows generally
  // send CSI for those regardless of cursor-key mode. So this stays
  // unmodified-arrows-only by design, not by oversight.
  const map: Record<string, Partial<InputKey>> = {
    P: { key: "F1" }, Q: { key: "F2" }, R: { key: "F3" }, S: { key: "F4" },
    H: { home: true }, F: { end: true },
    A: { upArrow: true }, B: { downArrow: true }, C: { rightArrow: true }, D: { leftArrow: true },
  };
  if (map[ch]) return [makeKey(map[ch].key || "", map[ch]), offset + 2];
  return null;
}

export interface ParseResult {
  keys: InputKey[];
  /** Incomplete paste content carried over if the buffer ended mid-paste (no \x1b[201~ yet). Pass back in as `pendingPaste` on the next call. */
  pendingPaste: string | null;
}

/**
 * Parses a chunk of raw terminal input into key events.
 * `pendingPaste`, if provided, is treated as unterminated paste content carried over from a
 * previous chunk (bracketed pastes can arrive split across multiple stdin `data` events).
 */
export function parseTerminalInput(buf: string, pendingPaste: string | null = null): ParseResult {
  const results: InputKey[] = [];
  let i = 0;
  let pasteBuf: string[] | null = pendingPaste !== null ? [pendingPaste] : null;

  while (i < buf.length) {
    const b = buf.charCodeAt(i);

    if (pasteBuf !== null) {
      const endIdx = buf.indexOf("\x1b[201~", i);
      if (endIdx >= 0) {
        pasteBuf.push(buf.slice(i, endIdx));
        results.push(makeKey("", { paste: pasteBuf.join("") }));
        i = endIdx + "\x1b[201~".length;
        pasteBuf = null;
        continue;
      }
      pasteBuf.push(buf.slice(i));
      return { keys: results, pendingPaste: pasteBuf.join("") };
    }

    if (buf.startsWith("\x1b[200~", i)) {
      pasteBuf = [];
      i += "\x1b[200~".length;
      continue;
    }

    if (b === 0x1b) {
      if (buf[i + 1] === "[") {
        const parsed = parseCsi(buf, i + 2);
        if (parsed) { results.push(parsed[0]); i = parsed[1]; continue; }
      }
      if (buf[i + 1] === "O") {
        const parsed = parseOseq(buf, i + 1);
        if (parsed) { results.push(parsed[0]); i = parsed[1]; continue; }
      }
      // "Meta sends escape" word-jump: some terminal configs (e.g. iTerm2's
      // "Natural Text Editing" preset) send Option+Left/Right as the readline
      // convention ESC b / ESC f instead of a CSI modified-arrow sequence.
      // Without this, the escape and the letter would fall through as two
      // separate events below — an `escape:true` key (which triggers
      // interrupt/dismiss handling) followed by a plain "b"/"f" character.
      if (buf[i + 1] === "b") { results.push(makeKey("", { meta: true, leftArrow: true })); i += 2; continue; }
      if (buf[i + 1] === "f") { results.push(makeKey("", { meta: true, rightArrow: true })); i += 2; continue; }
      // Option+Backspace (word-delete): macOS terminals send ESC + DEL.
      if (buf.charCodeAt(i + 1) === 0x7f) { results.push(makeKey("", { meta: true, backspace: true })); i += 2; continue; }
      results.push(makeKey("", { escape: true }));
      i++;
      continue;
    }

    if (b === 0x7f) { results.push(makeKey("", { backspace: true })); i++; continue; }
    if (b === 0x0d) { results.push(makeKey("\r", { return: true })); i++; continue; }
    if (b === 0x09) { results.push(makeKey("\t", { tab: true })); i++; continue; }

    if (b <= 0x1f) {
      const ctrlChar = String.fromCharCode(b + 0x60);
      results.push(makeKey(ctrlChar, { ctrl: true }));
      i++;
      continue;
    }

    results.push(makeKey(buf[i]));
    i++;
  }

  return { keys: results, pendingPaste: null };
}

// ── Single-wire input plumbing ─────────────────────────────────────────────
// PromptInput is conditionally mounted (unmounted while any modal is open), so
// attaching/removing a per-mount `data` listener flips the stream between
// flowing ('data' → our parser) and paused ('readable' → Ink's drain → useInput)
// at every modal open/close. A keypress landing in that transition window is
// consumed by the drain and dropped. We instead attach ONE `data` listener for
// the process lifetime and hand ownership to Ink by toggling stream mode
// (pause/resume) in a layout effect — which runs synchronously in the commit,
// before paint — so the mode is always settled before a key can physically
// arrive. A permanent listener WITHOUT the pause/resume toggle would keep
// eating bytes and starve Ink's readable drain forever (every modal useInput
// would freeze after the first keypress), so the toggles are mandatory.
//
// Single-instance assumption: only PromptInput uses this hook. If a second
// instance ever mounts, the later layout effect wins ownership (last attach).

let inputWireAttached = false;                        // idempotent attach guard (per module instance)
let inputWirePaste: string | null = null;             // split-paste buffer, survives remounts
let activeHandlerRef: { current: ((key: InputKey) => void) | null } | null = null;
let inputWireStdin: NodeJS.ReadableStream | null = null;
let inputWireRestore: (() => void) | null = null;

function onTerminalData(data: string | Buffer): void {
  const chunk = typeof data === "string" ? data : data.toString("utf-8");
  const { keys, pendingPaste } = parseTerminalInput(chunk, inputWirePaste);
  inputWirePaste = pendingPaste;
  const handler = activeHandlerRef?.current;
  if (!handler) return;                               // inactive: stream is paused, Ink owns it
  for (const key of keys) handler(key);
}

/** Attach the single-wire listener to a stream. Idempotent per module instance. */
export function attachInputWire(stdin: NodeJS.ReadableStream): void {
  if (inputWireAttached) return;
  inputWireAttached = true;
  inputWireStdin = stdin;
  stdin.on("data", onTerminalData);
  // Without this the terminal sends a paste as bare bytes, so every embedded
  // newline reaches the handler as a plain Enter and submits that line on its
  // own. The mode is enabled for the wire's lifetime (the process), matching
  // the \x1b[200~/\x1b[201~ framing parseTerminalInput expects.
  enableBracketedPaste();
  const restore = (): void => disableBracketedPaste();
  inputWireRestore = restore;
  process.on("exit", restore);
  process.once("SIGINT", restore);
  process.once("SIGTERM", restore);
}

/** Test-only: reset module-level wire state between tests. */
export function __resetInputWireForTests(): void {
  // Each Vitest test gets a fresh module instance but shares the real process
  // and stdin proxy. Remove the process/stream listeners from the previous
  // instance before allowing the next test to attach another wire; otherwise
  // repeated renders accumulate SIGINT/SIGTERM/exit listeners and trigger
  // Node's MaxListenersExceededWarning.
  inputWireStdin?.removeListener("data", onTerminalData);
  if (inputWireRestore) {
    process.off("exit", inputWireRestore);
    process.off("SIGINT", inputWireRestore);
    process.off("SIGTERM", inputWireRestore);
    inputWireRestore();
  }
  inputWireAttached = false;
  inputWirePaste = null;
  activeHandlerRef = null;
  inputWireStdin = null;
  inputWireRestore = null;
}

/** Test-only: install (or clear, with null) the active dispatch handler. */
export function __setActiveHandlerForTests(handler: ((key: InputKey) => void) | null): void {
  activeHandlerRef = handler ? { current: handler } : null;
}

export function useTerminalInput(handler: (key: InputKey) => void, { isActive }: { isActive: boolean }): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;                       // always the latest render's closure
  const { stdin, setRawMode } = useStdin();

  useLayoutEffect(() => {
    if (!stdin) return;
    attachInputWire(stdin);
    if (setRawMode) setRawMode(true);

    if (isActive) {
      activeHandlerRef = handlerRef;
      stdin.resume();   // flowing: 'data' → our parser (PromptInput owns input)
    } else {
      activeHandlerRef = null;
      stdin.pause();    // paused: 'readable' → Ink's drain → useInput (modals)
    }

    return () => {
      // Unmount (a modal opened): hand the stream back to Ink's readable drain.
      // The 'data' listener STAYS attached — no churn, no race window.
      if (activeHandlerRef === handlerRef) activeHandlerRef = null;
      stdin.pause();
    };
  }, [isActive, stdin, setRawMode]);
}
