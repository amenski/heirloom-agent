export type PromptBufferState = {
  text: string;
  cursor: number;
};

export const EMPTY_BUFFER: PromptBufferState = { text: "", cursor: 0 };

export function insertText(state: PromptBufferState, value: string): PromptBufferState {
  if (!value) return state;
  const text = state.text.slice(0, state.cursor) + value + state.text.slice(state.cursor);
  return { text, cursor: state.cursor + value.length };
}

export function backspace(state: PromptBufferState): PromptBufferState {
  if (state.cursor === 0) return state;
  const text = state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor);
  return { text, cursor: state.cursor - 1 };
}

export function deleteForward(state: PromptBufferState): PromptBufferState {
  if (state.cursor >= state.text.length) return state;
  const text = state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1);
  return { text, cursor: state.cursor };
}

export function moveLeft(state: PromptBufferState): PromptBufferState {
  if (state.cursor === 0) return state;
  return { ...state, cursor: state.cursor - 1 };
}

export function moveRight(state: PromptBufferState): PromptBufferState {
  if (state.cursor >= state.text.length) return state;
  return { ...state, cursor: state.cursor + 1 };
}

export function moveWordLeft(state: PromptBufferState): PromptBufferState {
  let cursor = state.cursor;
  while (cursor > 0 && /\s/.test(state.text[cursor - 1] ?? "")) cursor--;
  while (cursor > 0 && !/\s/.test(state.text[cursor - 1] ?? "")) cursor--;
  return { ...state, cursor };
}

export function moveWordRight(state: PromptBufferState): PromptBufferState {
  let cursor = state.cursor;
  while (cursor < state.text.length && /\s/.test(state.text[cursor] ?? "")) cursor++;
  while (cursor < state.text.length && !/\s/.test(state.text[cursor] ?? "")) cursor++;
  return { ...state, cursor };
}

export function moveLineStart(state: PromptBufferState): PromptBufferState {
  const lineStart = state.text.lastIndexOf("\n", state.cursor - 1) + 1;
  return { ...state, cursor: lineStart };
}

export function moveLineEnd(state: PromptBufferState): PromptBufferState {
  const nextNewline = state.text.indexOf("\n", state.cursor);
  const lineEnd = nextNewline === -1 ? state.text.length : nextNewline;
  return { ...state, cursor: lineEnd };
}

export function killLine(state: PromptBufferState): PromptBufferState {
  const nextNewline = state.text.indexOf("\n", state.cursor);
  const lineEnd = nextNewline === -1 ? state.text.length : nextNewline;
  if (state.cursor >= lineEnd) return state;
  return { text: state.text.slice(0, state.cursor) + state.text.slice(lineEnd), cursor: state.cursor };
}

export function deleteWordBefore(state: PromptBufferState): PromptBufferState {
  let end = state.cursor;
  let start = end;
  while (start > 0 && /\s/.test(state.text[start - 1] ?? "")) start--;
  while (start > 0 && !/\s/.test(state.text[start - 1] ?? "")) start--;
  if (start === end) return state;
  return { text: state.text.slice(0, start) + state.text.slice(end), cursor: start };
}

export function deleteWordAfter(state: PromptBufferState): PromptBufferState {
  const start = state.cursor;
  let end = start;
  while (end < state.text.length && /\s/.test(state.text[end] ?? "")) end++;
  while (end < state.text.length && !/\s/.test(state.text[end] ?? "")) end++;
  if (start === end) return state;
  return { text: state.text.slice(0, start) + state.text.slice(end), cursor: start };
}

export function isEmpty(state: PromptBufferState): boolean {
  return state.text.length === 0;
}

export function getCurrentSlashToken(state: PromptBufferState): string | null {
  const before = state.text.slice(0, state.cursor);
  const slashIdx = before.lastIndexOf("/");
  if (slashIdx < 0 || (slashIdx > 0 && !/\s/.test(before[slashIdx - 1] ?? ""))) return null;
  const afterSlash = state.text.slice(slashIdx);
  const endIdx = afterSlash.search(/\s/);
  const token = endIdx === -1 ? afterSlash : afterSlash.slice(0, endIdx);
  if (!token.startsWith("/")) return null;
  return token;
}

export function getCurrentFileMentionToken(state: PromptBufferState): { query: string; start: number } | null {
  const before = state.text.slice(0, state.cursor);
  const atIdx = before.lastIndexOf("@");
  if (atIdx < 0 || (atIdx > 0 && !/\s/.test(before[atIdx - 1] ?? ""))) return null;
  const afterAt = state.text.slice(atIdx + 1);
  const endIdx = afterAt.search(/[\s"]/);
  const query = endIdx === -1 ? afterAt : afterAt.slice(0, endIdx);
  if (!query) return null;
  return { query, start: atIdx };
}
