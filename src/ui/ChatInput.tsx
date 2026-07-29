import React, { useState, useRef } from "react";
import { Text, useInput } from "ink";

interface ChatInputProps {
  promptStr: string;
  busy: boolean;
  onSubmit: (text: string) => void;
  onCompletions: (lines: string[]) => void;
  completer: (line: string) => [string[], string];
  onModelPickerOpen: () => void;
}

/**
 * Text input with cursor, word navigation, history, tab completion.
 * Owns its own state and registers its own useInput handler (Ink supports
 * multiple handlers — this one processes editing keys; App.tsx handles
 * modal and admin keys).
 */
export default function ChatInput({
  promptStr,
  busy,
  onSubmit,
  onCompletions,
  completer,
  onModelPickerOpen,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const draftRef = useRef("");

  function submitCurrent() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setHistory((prev) => [trimmed, ...prev.slice(0, 99)]);
    setHistoryIdx(-1);
    setText("");
    setCursor(0);
    onSubmit(trimmed);
  }

  useInput((value: string, key: any) => {
    // Skip all input processing when busy (App's useInput handles abort)
    if (busy) return;

    // ── Submit ──
    if (key.return) {
      submitCurrent();
      return;
    }

    // ── Tab completion ──
    if (key.tab) {
      const [completions, prefix] = completer(text);
      if (completions.length === 1) {
        setText(prefix + completions[0]);
        setCursor((prefix + completions[0]).length);
      } else if (completions.length > 1) {
        onCompletions(completions);
      }
      return;
    }

    // ── History ──
    if (key.upArrow) {
      if (history.length > 0 && historyIdx < history.length - 1) {
        if (historyIdx === -1) draftRef.current = text;
        const newIdx = historyIdx + 1;
        setHistoryIdx(newIdx);
        const line = history[newIdx];
        setText(line);
        setCursor(line.length);
      }
      return;
    }

    if (key.downArrow) {
      if (historyIdx < 0) return;
      const newIdx = historyIdx - 1;
      setHistoryIdx(newIdx);
      const line = newIdx === -1 ? draftRef.current : history[newIdx];
      setText(line);
      setCursor(line.length);
      return;
    }

    // ── Cursor left ──
    if (key.leftArrow) {
      if ((key.ctrl || key.meta) && cursor > 0) {
        const before = text.slice(0, cursor).trimEnd();
        const wordStart = before.lastIndexOf(" ");
        setCursor(wordStart >= 0 ? wordStart + 1 : 0);
      } else if (cursor > 0) {
        setCursor((c) => c - 1);
      }
      return;
    }

    // ── Cursor right ──
    if (key.rightArrow) {
      if (key.ctrl || key.meta) {
        const after = text.slice(cursor);
        const nextWord = after.trimStart();
        const nonSpaceStart = after.indexOf(nextWord.charAt(0));
        if (nonSpaceStart < 0) {
          setCursor(text.length);
        } else {
          const wordEnd = after.slice(nonSpaceStart).indexOf(" ");
          setCursor(wordEnd < 0 ? text.length : cursor + nonSpaceStart + wordEnd);
        }
      } else if (cursor < text.length) {
        setCursor((c) => c + 1);
      }
      return;
    }

    // ── Backspace / delete ──
    if (key.backspace || key.delete) {
      if ((key.ctrl || key.meta) && cursor > 0) {
        const before = text.slice(0, cursor).trimEnd();
        const wordStart = before.lastIndexOf(" ");
        const deleteIdx = wordStart >= 0 ? wordStart + 1 : 0;
        setText(text.slice(0, deleteIdx) + text.slice(cursor));
        setCursor(deleteIdx);
      } else if (key.backspace && cursor > 0) {
        setText(text.slice(0, cursor - 1) + text.slice(cursor));
        setCursor((c) => c - 1);
      } else if (key.delete && cursor < text.length) {
        setText(text.slice(0, cursor) + text.slice(cursor + 1));
      }
      return;
    }

    // ── Ctrl-H clears the line (also catches ctrl+h via backspace fallthrough) ──
    if (key.ctrl && key.name === "h") {
      setText("");
      setCursor(0);
      return;
    }

    // ── Printable character ──
    if (value) {
      setText(text.slice(0, cursor) + value + text.slice(cursor));
      setCursor((c) => c + value.length);
    }
  });

  return (
    <Text>
      {promptStr}
      {text.slice(0, cursor)}
      {cursor < text.length ? (
        <Text inverse>{text[cursor]}</Text>
      ) : (
        <Text inverse> </Text>
      )}
      {text.slice(cursor + 1)}
    </Text>
  );
}
