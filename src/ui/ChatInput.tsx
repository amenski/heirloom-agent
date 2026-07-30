/**
 * Heirloom ChatInput — Professional-grade Ink text input
 *
 * Features:
 * - Full cursor movement (char, word, home/end)
 * - History navigation with fuzzy search (Ctrl+R)
 * - Tab completion with inline preview
 * - Word-aware delete (Ctrl+Backspace/Del)
 * - Ctrl+U to clear line
 * - Autocomplete suggestions popup
 * - Themable via ThemeContext
 * - Character count / input length display
 */

import React, { useState, useRef, useCallback, useEffect, memo } from "react";
import { Text, useInput } from "ink";
import { appendFileSync } from "node:fs";
import { fuzzyFilter, highlightMatches } from "./FuzzySearch.js";
import { useTheme } from "./contexts.js";

interface ChatInputProps {
  promptStr: string;
  busy: boolean;
  onSubmit: (text: string) => void;
  onCompletions: (lines: string[]) => void;
  completer: (line: string) => [string[], string];
  onModelPickerOpen: () => void;
  /** Max input length before visual warning */
  maxLength?: number;
}

interface Suggestion {
  text: string;
  score: number;
}

function ChatInput({
  promptStr,
  busy,
  onSubmit,
  onCompletions,
  completer,
  onModelPickerOpen,
  maxLength = 4000,
}: ChatInputProps) {
  const theme = useTheme();
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const textRef = useRef(text);
  textRef.current = text;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const draftRef = useRef("");
  const [fuzzyMode, setFuzzyMode] = useState(false);
  const [fuzzyQuery, setFuzzyQuery] = useState("");
  const [fuzzyResults, setFuzzyResults] = useState<Suggestion[]>([]);
  const [fuzzySelection, setFuzzySelection] = useState(0);

  useEffect(() => {
    try { appendFileSync("/tmp/heirloom_debug.log", "CHATINPUT MOUNT\n"); } catch {}
    return () => {
      try { appendFileSync("/tmp/heirloom_debug.log", "CHATINPUT UNMOUNT\n"); } catch {}
    };
  }, []);

  // Autocomplete suggestions (inline, below input)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionIdx, setSuggestionIdx] = useState(0);

  const colorEnabled = theme.colorEnabled;
  const t = {
    prompt: (s: string) => (colorEnabled ? `\x1b[38;5;${theme.theme.promptFg}m${s}\x1b[0m` : s),
    dim: (s: string) => (colorEnabled ? `\x1b[2m${s}\x1b[0m` : s),
  };

  // Update suggestions when text changes
  useEffect(() => {
    if (text.trim().length > 1 && !busy) {
      const fuzzy = fuzzyFilter(history.slice(0, 50), text);
      if (fuzzy.length > 0) {
        setSuggestions(
          fuzzy.slice(0, 5).map((m) => ({ text: m.item, score: m.score })),
        );
        setSuggestionIdx(0);
        return;
      }
    }
    setSuggestions([]);
  }, [text, history, busy]);

  function submitCurrent() {
    const curText = textRef.current;
    const trimmed = curText.trim();
    if (!trimmed) return;
    setHistory((prev) => [trimmed, ...prev.slice(0, 99)]);
    setHistoryIdx(-1);
    setText("");
    setCursor(0);
    setFuzzyMode(false);
    setSuggestions([]);
    onSubmit(trimmed);
  }

  function acceptSuggestion(index: number) {
    if (index >= 0 && index < suggestions.length) {
      setText(suggestions[index].text);
      setCursor(suggestions[index].text.length);
      setSuggestions([]);
    }
  }

  // Fuzzy search mode handler
  function enterFuzzySearch() {
    setFuzzyMode(true);
    setFuzzyQuery("");
    setFuzzyResults(
      history.slice(0, 50).map((h) => ({ text: h, score: 50 })),
    );
    setFuzzySelection(0);
  }

  function exitFuzzySearch() {
    setFuzzyMode(false);
    setFuzzyQuery("");
    setFuzzyResults([]);
  }

  function acceptFuzzySelection(index: number) {
    if (index >= 0 && index < fuzzyResults.length) {
      setText(fuzzyResults[index].text);
      setCursor(fuzzyResults[index].text.length);
    }
    exitFuzzySearch();
  }

  useInput((value: string, key: any) => {
    const curText = textRef.current;
    const curCursor = cursorRef.current;
    try { appendFileSync("/tmp/heirloom_debug.log", `value=${JSON.stringify(value)} key=${JSON.stringify(key)} text=${JSON.stringify(curText)} cursor=${curCursor}\n`); } catch {}
    if (busy) return;

    if (fuzzyMode) {
      if (key.escape || (key.ctrl && key.name === "c")) {
        exitFuzzySearch();
        return;
      }
      if (key.return) {
        acceptFuzzySelection(fuzzySelection);
        return;
      }
      if (key.upArrow) {
        setFuzzySelection((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setFuzzySelection((s) => Math.min(fuzzyResults.length - 1, s + 1));
        return;
      }
      if (key.backspace && fuzzyQuery.length > 0) {
        const newQuery = fuzzyQuery.slice(0, -1);
        setFuzzyQuery(newQuery);
        const results = fuzzyFilter(history, newQuery);
        setFuzzyResults(results.map((r) => ({ text: r.item, score: r.score })));
        setFuzzySelection(0);
        return;
      }
      if (value) {
        const newQuery = fuzzyQuery + value;
        setFuzzyQuery(newQuery);
        const results = fuzzyFilter(history, newQuery);
        setFuzzyResults(results.map((r) => ({ text: r.item, score: r.score })));
        setFuzzySelection(0);
        return;
      }
      return;
    }

    if (key.return) {
      if (suggestions.length > 0 && suggestionIdx >= 0) {
        acceptSuggestion(suggestionIdx);
        return;
      }
      submitCurrent();
      return;
    }

    if (key.tab) {
      const [completions, prefix] = completer(curText);
      if (completions.length === 1) {
        setText(prefix + completions[0]);
        setCursor((prefix + completions[0]).length);
      } else if (completions.length > 1) {
        onCompletions(completions);
      }
      return;
    }

    if (key.ctrl && key.name === "r") {
      enterFuzzySearch();
      return;
    }

    if (key.upArrow) {
      if (history.length > 0 && historyIdx < history.length - 1) {
        if (historyIdx === -1) draftRef.current = curText;
        const newIdx = historyIdx + 1;
        setHistoryIdx(newIdx);
        setText(history[newIdx]);
        setCursor(history[newIdx].length);
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

    if (key.leftArrow) {
      if ((key.ctrl || key.meta) && curCursor > 0) {
        const before = curText.slice(0, curCursor).trimEnd();
        setCursor(before.lastIndexOf(" ") >= 0 ? before.lastIndexOf(" ") + 1 : 0);
      } else if (curCursor > 0) {
        setCursor((c) => c - 1);
      }
      return;
    }

    if (key.rightArrow) {
      if ((key.ctrl || key.meta) && curCursor < curText.length) {
        const after = curText.slice(curCursor);
        const nextWord = after.search(/\S/);
        if (nextWord < 0) {
          setCursor(curText.length);
        } else {
          const wordEnd = after.slice(nextWord).search(/\s/);
          setCursor(wordEnd < 0 ? curText.length : curCursor + nextWord + wordEnd);
        }
      } else if (curCursor < curText.length) {
        setCursor((c) => c + 1);
      }
      return;
    }

    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(curText.length);
      return;
    }

    if (key.backspace || key.delete) {
      if ((key.ctrl || key.meta) && curCursor > 0) {
        const before = curText.slice(0, curCursor).trimEnd();
        const deleteIdx = before.lastIndexOf(" ") >= 0 ? before.lastIndexOf(" ") + 1 : 0;
        setText(curText.slice(0, deleteIdx) + curText.slice(curCursor));
        setCursor(deleteIdx);
      } else if (key.backspace && curCursor > 0) {
        setText(curText.slice(0, curCursor - 1) + curText.slice(curCursor));
        setCursor(curCursor - 1);
      } else if (key.delete && curCursor < curText.length) {
        setText(curText.slice(0, curCursor) + curText.slice(curCursor + 1));
      }
      return;
    }

    if (key.ctrl && key.name === "u") {
      setText("");
      setCursor(0);
      return;
    }

    if (key.ctrl && key.name === "w") {
      if (curCursor > 0) {
        const before = curText.slice(0, curCursor).trimEnd();
        const deleteIdx = before.lastIndexOf(" ") >= 0 ? before.lastIndexOf(" ") + 1 : 0;
        setText(curText.slice(0, deleteIdx) + curText.slice(curCursor));
        setCursor(deleteIdx);
      }
      return;
    }

    if (value) {
      if (curText.length >= maxLength) return;
      const newText = curText.slice(0, curCursor) + value + curText.slice(curCursor);
      setText(newText);
      setCursor(curCursor + value.length);
    }
  });

  // Render fuzzy search overlay
  if (fuzzyMode) {
    return (
      <Text>
        {t.dim("fuzzy-search> ")}
        {fuzzyQuery}
        <Text inverse> </Text>
        {"\n"}
        {fuzzyResults.slice(0, 10).map((result, i) => (
          <Text key={i}>
            {"\n"}
            {i === fuzzySelection ? (
              <Text bold inverse>
                {`> ${result.text}`}
              </Text>
            ) : (
              <Text dimColor>
                {`  ${result.text}`}
              </Text>
            )}
          </Text>
        ))}
      </Text>
    );
  }

  // Show character count when nearing the limit
  const showCharCount = text.length > maxLength * 0.8;

  return (
    <Text>
      {t.prompt(promptStr)}
      {text.slice(0, cursor)}
      {cursor < text.length ? (
        <Text inverse>{text[cursor]}</Text>
      ) : (
        <Text inverse> </Text>
      )}
      {text.slice(cursor + 1)}
      {/* Render inline autocomplete suggestion */}
      {suggestions.length > 0 &&
        suggestionIdx >= 0 &&
        suggestions[suggestionIdx] &&
        text.length < suggestions[suggestionIdx].text.length && (
          <Text dimColor>
            {suggestions[suggestionIdx].text.slice(text.length)}
          </Text>
        )}
      {/* Character count indicator when nearing limit */}
      {showCharCount && (
        <Text dimColor>
          {t.dim(` ${text.length}/${maxLength}`)}
        </Text>
      )}
    </Text>
  );
}

export default memo(ChatInput);
