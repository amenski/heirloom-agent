import { useCallback, useState } from "react";
import type { PromptBufferState } from "../core/prompt-buffer.js";

export function useHistoryNavigation(
  buffer: PromptBufferState,
  setBuffer: React.Dispatch<React.SetStateAction<PromptBufferState>>,
  promptHistory: string[],
) {
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState<string | null>(null);

  const exitHistoryBrowsing = useCallback(() => {
    setHistoryCursor(-1);
    setDraftBeforeHistory(null);
  }, []);

  function navigateHistory(direction: -1 | 1): void {
    if (promptHistory.length === 0) return;
    const previousCursor = historyCursor === -1 ? promptHistory.length : historyCursor;
    const nextCursor = Math.max(0, Math.min(promptHistory.length, previousCursor + direction));
    const draft = historyCursor === -1 ? buffer.text : draftBeforeHistory;
    if (historyCursor === -1) setDraftBeforeHistory(buffer.text);
    if (nextCursor === promptHistory.length) {
      const text = draft ?? "";
      setBuffer({ text, cursor: text.length });
      setHistoryCursor(-1);
      setDraftBeforeHistory(null);
      return;
    }
    const text = promptHistory[nextCursor] ?? "";
    setBuffer({ text, cursor: text.length });
    setHistoryCursor(nextCursor);
  }

  return { historyCursor, draftBeforeHistory, navigateHistory, exitHistoryBrowsing };
}
