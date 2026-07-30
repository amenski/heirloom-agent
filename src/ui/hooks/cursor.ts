function isCjk(ch: string): boolean {
  if (!ch || ch.length === 0) return false;
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (code >= 0x1100 && code <= 0x115F) ||
    (code >= 0x2E80 && code <= 0xA4CF) ||
    (code >= 0xAC00 && code <= 0xD7A3) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE10 && code <= 0xFE19) ||
    (code >= 0xFE30 && code <= 0xFE6F) ||
    (code >= 0xFF00 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) ||
    (code >= 0x1F300 && code <= 0x1F64F) ||
    (code >= 0x1F680 && code <= 0x1F6FF) ||
    (code >= 0x2600 && code <= 0x26FF);
}

export function visualWidth(ch: string): number {
  if (!ch || ch.length === 0) return 0;
  const code = ch.codePointAt(0);
  if (code === undefined) return 0;
  if (code === 0) return 0;
  if (code <= 0x1F || (code >= 0x7F && code <= 0x9F)) return 0;
  if (isCjk(ch)) return 2;
  return 1;
}

export function strWidth(str: string): number {
  let width = 0;
  for (let i = 0; i < str.length;) {
    const code = str.codePointAt(i);
    if (code === undefined) { i++; continue; }
    const char = String.fromCodePoint(code);
    width += visualWidth(char);
    i += char.length;
  }
  return width;
}

export function cursorShow(): string {
  return "\x1b[?25h";
}

export function cursorHide(): string {
  return "\x1b[?25l";
}

export function bracketedPasteStart(): string {
  return "\x1b[?2004h";
}

export function bracketedPasteEnd(): string {
  return "\x1b[?2004l";
}

export function cursorMove(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function getPromptCursorPlacement(text: string, cursor: number, prefixWidth: number): { row: number; col: number } {
  let col = prefixWidth;
  let row = 0;
  for (let i = 0; i < cursor && i < text.length;) {
    const code = text.codePointAt(i);
    if (code === undefined) { i++; continue; }
    const ch = String.fromCodePoint(code);
    if (ch === "\n") { col = 0; row++; i++; continue; }
    col += visualWidth(ch);
    i += ch.length;
  }
  return { row, col };
}

export function usePromptTerminalCursor(
  cursor: number,
  text: string,
  prefixWidth: number,
): void {
  const placement = getPromptCursorPlacement(text, cursor, prefixWidth);
  process.stdout.write(cursorMove(placement.row + 1, placement.col + 1));
}
