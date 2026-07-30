import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import { PROMPT_PREFIX_WIDTH } from "../constants.js";
import {
  EMPTY_BUFFER,
  backspace, deleteForward, deleteWordBefore, deleteWordAfter,
  insertText, isEmpty, moveLeft, moveRight, moveLineStart, moveLineEnd,
  moveWordLeft, moveWordRight, killLine,
  getCurrentSlashToken,
  type PromptBufferState,
} from "../core/prompt-buffer.js";
import {
  createPromptUndoRedoState, recordPromptEdit, undoPromptEdit, redoPromptEdit, clearPromptUndoRedoState,
} from "../core/prompt-undo-redo.js";
import { getSlashCommands, filterSlashCommands, findExactSlashCommand, type SlashCommandItem } from "../core/slash-commands.js";
import { useHistoryNavigation } from "../hooks/useHistoryNavigation.js";
import { readClipboardImageAsync } from "../core/clipboard.js";
import { useTerminalInput, type InputKey } from "../hooks/useTerminalInput.js";
import SlashCommandMenu from "./SlashCommandMenu.js";
import type { StatusSegment } from "../types.js";

export type PromptSubmission = {
  text: string;
  command?: "new" | "resume" | "continue" | "undo" | "mcp" | "exit";
  imageUrls?: string[];
};

interface Props {
  screenWidth: number;
  promptHistory: string[];
  busy: boolean;
  placeholder?: string;
  statusLineSegments?: StatusSegment[];
  promptDraft?: { nonce: number; text: string } | null;
  statusLineSeparator?: string;
  onSubmit: (submission: PromptSubmission) => void;
  onInterrupt?: () => void;
  onExitShortcut?: () => void;
  onModelPickerOpen?: () => void;
  onTogglePlanMode?: () => void;
}

const PromptInput = React.memo(function PromptInput({
  screenWidth, promptHistory, busy, placeholder, statusLineSegments, statusLineSeparator,
  promptDraft, onSubmit, onInterrupt, onExitShortcut, onModelPickerOpen, onTogglePlanMode,
}: Props): React.ReactElement {
  const undoRedoRef = useRef(createPromptUndoRedoState());
  const wasBusyRef = useRef(busy);
  const appliedDraftNonceRef = useRef<number | null>(null);

  const [buffer, setBuffer] = useState<PromptBufferState>(EMPTY_BUFFER);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [pendingExit, setPendingExit] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const attachedImagesRef = useRef(attachedImages);
  attachedImagesRef.current = attachedImages;

  const { historyCursor, navigateHistory, exitHistoryBrowsing } = useHistoryNavigation(buffer, setBuffer, promptHistory);

  const slashToken = getCurrentSlashToken(buffer);
  const slashItems = useMemo(() => getSlashCommands(), []);
  const slashMenu = useMemo(() => slashToken ? filterSlashCommands(slashItems, slashToken) : [], [slashToken, slashItems]);
  const showMenu = slashMenu.length > 0;

  const lastCtrlDAt = useRef<number>(0);
  const inputContentWidth = Math.max(1, screenWidth - PROMPT_PREFIX_WIDTH);
  const footerText = statusMessage || (busy ? "esc to interrupt · ctrl+c cancel" : "enter send · shift+enter newline · @ files · ctrl+v image · / commands · ctrl+d exit");

  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(null), 2500);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    if (!showMenu) { setMenuIndex(0); return; }
    if (menuIndex >= slashMenu.length) setMenuIndex(slashMenu.length - 1);
  }, [slashMenu, showMenu, menuIndex]);

  useEffect(() => {
    if (wasBusyRef.current && !busy) setStatusMessage(null);
    wasBusyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!promptDraft || appliedDraftNonceRef.current === promptDraft.nonce) return;
    appliedDraftNonceRef.current = promptDraft.nonce;
    setBuffer({ text: promptDraft.text, cursor: promptDraft.text.length });
    exitHistoryBrowsing();
    clearPromptUndoRedoState(undoRedoRef.current);
  }, [promptDraft, exitHistoryBrowsing]);

  const promptHistoryKey = useMemo(() => promptHistory.join("\0"), [promptHistory]);

  useEffect(() => { exitHistoryBrowsing(); }, [promptHistoryKey, exitHistoryBrowsing]);

  function updateBuffer(updater: (state: PromptBufferState) => PromptBufferState): void {
    exitHistoryBrowsing();
    setBuffer((current) => {
      const next = updater(current);
      recordPromptEdit(undoRedoRef.current, current, next);
      return next;
    });
  }

  function handleSlashSelection(item: SlashCommandItem): void {
    if (busy && item.kind !== "exit") { setStatusMessage("wait for response or press esc"); return; }
    if (item.kind === "new") { onSubmit({ text: "", command: "new" }); resetInput(); return; }
    if (item.kind === "resume") { onSubmit({ text: "", command: "resume" }); resetInput(); return; }
    if (item.kind === "continue") { onSubmit({ text: "/continue", command: "continue" }); resetInput(); return; }
    if (item.kind === "undo") { onSubmit({ text: "/undo", command: "undo" }); resetInput(); return; }
    if (item.kind === "mcp") { onSubmit({ text: "/mcp", command: "mcp" }); resetInput(); return; }
    if (item.kind === "exit") { onSubmit({ text: "/exit", command: "exit" }); return; }
    if (item.kind === "clear") { const text = "/clear"; setBuffer({ text, cursor: text.length }); return; }
    if (item.kind === "help") { const text = "/help"; setBuffer({ text, cursor: text.length }); return; }
    if (item.kind === "skills") { const text = "/skills"; setBuffer({ text, cursor: text.length }); return; }
    if (item.kind === "model") { onModelPickerOpen?.(); return; }
    if (item.kind === "plan") { onTogglePlanMode?.(); return; }
    if (item.kind === "raw") { const text = "/raw"; setBuffer({ text, cursor: text.length }); return; }
  }

  function submitCurrent(): void {
    if (busy) { setStatusMessage("wait for response or press esc"); return; }
    const trimmed = buffer.text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      const exactMatch = findExactSlashCommand(slashItems, trimmed.split(/\s+/, 1)[0]);
      if (exactMatch) { handleSlashSelection(exactMatch); return; }
    }
    const imageUrls = attachedImagesRef.current;
    onSubmit({ text: trimmed, ...(imageUrls.length ? { imageUrls } : {}) });
    resetInput();
  }

  function resetInput(): void {
    setBuffer(EMPTY_BUFFER);
    clearPromptUndoRedoState(undoRedoRef.current);
    setAttachedImages([]);
  }

  useTerminalInput((key: InputKey) => {
    const curText = bufferRef.current;

    if (key.paste) {
      const sanitized = key.paste.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      updateBuffer((s) => insertText(s, sanitized));
      return;
    }

    if (busy) {
      if (key.escape || (key.ctrl && key.value === "c")) { onInterrupt?.(); setStatusMessage("Interrupting…"); }
      return;
    }

    if (key.escape) { onInterrupt?.(); return; }

    if (key.ctrl && key.value === "d") {
      if (isEmpty(curText)) {
        const now = Date.now();
        if (pendingExit && now - lastCtrlDAt.current < 2000) { onExitShortcut?.(); return; }
        lastCtrlDAt.current = now;
        setPendingExit(true); setStatusMessage("press ctrl+d again to exit"); return;
      }
    }

    if (pendingExit) setPendingExit(false);

    if (key.ctrl && key.value === "c") {
      if (!isEmpty(curText)) { resetInput(); } else { setStatusMessage("press ctrl+d to exit"); }
      return;
    }

    if (historyCursor !== -1 && !key.upArrow && !key.downArrow) exitHistoryBrowsing();

    if (showMenu) {
      if (key.upArrow) { setMenuIndex((i) => (i - 1 + slashMenu.length) % slashMenu.length); return; }
      if (key.downArrow) { setMenuIndex((i) => (i + 1) % slashMenu.length); return; }
      if (key.tab || key.return) {
        const selected = slashMenu[menuIndex];
        if (selected) { handleSlashSelection(selected); return; }
      }
    }

    const noMod = !key.shift && !key.ctrl && !key.meta;

    if (key.shift && key.tab) {
      onTogglePlanMode?.();
      return;
    }

    if (key.shift && key.return) { updateBuffer((s) => insertText(s, "\n")); return; }
    if (key.return) { submitCurrent(); return; }

    if (key.delete) { updateBuffer((s) => deleteForward(s)); return; }
    if (key.backspace) { updateBuffer((s) => backspace(s)); return; }

    if ((key.ctrl || key.meta) && key.leftArrow) { updateBuffer((s) => moveWordLeft(s)); return; }
    if ((key.ctrl || key.meta) && key.rightArrow) { updateBuffer((s) => moveWordRight(s)); return; }
    if (key.leftArrow) { updateBuffer((s) => moveLeft(s)); return; }
    if (key.rightArrow) { updateBuffer((s) => moveRight(s)); return; }
    if (key.home) { updateBuffer((s) => moveLineStart(s)); return; }
    if (key.end) { updateBuffer((s) => moveLineEnd(s)); return; }

    if (key.upArrow) {
      if (noMod && (historyCursor !== -1 || curText.cursor === 0) && promptHistory.length > 0) { navigateHistory(-1); return; }
      return;
    }
    if (key.downArrow) {
      if (noMod && (historyCursor !== -1 || curText.cursor === curText.text.length)) { navigateHistory(1); return; }
      return;
    }

    if (key.ctrl && key.value === "p") { navigateHistory(-1); return; }
    if (key.ctrl && key.value === "n") { navigateHistory(1); return; }
    if (key.ctrl && key.value === "a") { updateBuffer((s) => moveLineStart(s)); return; }
    if (key.ctrl && key.value === "e") { updateBuffer((s) => moveLineEnd(s)); return; }
    if (key.ctrl && key.value === "b") { updateBuffer((s) => moveLeft(s)); return; }
    if (key.ctrl && key.value === "f") { updateBuffer((s) => moveRight(s)); return; }
    if (key.ctrl && key.value === "k") { updateBuffer((s) => killLine(s)); return; }
    if (key.ctrl && key.value === "u") { updateBuffer(() => EMPTY_BUFFER); return; }
    if (key.ctrl && key.value === "w") { updateBuffer((s) => deleteWordBefore(s)); return; }
    if (key.ctrl && key.value === "j") { updateBuffer((s) => insertText(s, "\n")); return; }
    if (key.ctrl && key.value === "m") { onModelPickerOpen?.(); return; }

    if (key.ctrl && key.value === "v") {
      setStatusMessage("Reading clipboard image…");
      readClipboardImageAsync()
        .then((image) => {
          if (!image) { setStatusMessage("No image found in clipboard"); return; }
          setAttachedImages((prev) => [...prev, image.dataUrl]);
          setStatusMessage(null);
        })
        .catch(() => setStatusMessage("Failed to read clipboard image"));
      return;
    }
    if (key.ctrl && key.value === "x") {
      if (attachedImagesRef.current.length > 0) { setAttachedImages([]); setStatusMessage("Cleared attached images"); }
      return;
    }

    if (key.value) {
      const sanitized = key.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      updateBuffer((s) => insertText(s, sanitized));
    }
  }, { isActive: true });

  return (
    <Box flexDirection="column" width={screenWidth}>
      <Box
        width={screenWidth}
        borderStyle="single"
        borderTop={true}
        borderBottom={true}
        borderLeft={false}
        borderRight={false}
        borderDimColor
      >
        <Box width={PROMPT_PREFIX_WIDTH}>
          <Text color="#229ac3">{"> "}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} width={inputContentWidth}>
          <Text wrap="hard">
            {renderBufferWithCursor(buffer, placeholder)}
          </Text>
        </Box>
      </Box>
      <SlashCommandMenu width={screenWidth} items={slashMenu} activeIndex={menuIndex} />
      {attachedImages.length > 0 && (
        <Box><Text color="yellow">📎 {attachedImages.length} image{attachedImages.length === 1 ? "" : "s"} attached (ctrl+x to clear)</Text></Box>
      )}
      {!showMenu && !(statusLineSegments && statusLineSegments.length > 0) && (
        <Box><Text dimColor>{footerText}</Text></Box>
      )}
      {statusLineSegments && statusLineSegments.length > 0 && (
        <Box flexDirection="column">
          {(() => {
            const lines: StatusSegment[][] = [];
            let currentLine: StatusSegment[] = [];
            for (const segment of statusLineSegments) {
              if (segment.newLine && currentLine.length > 0) { lines.push(currentLine); currentLine = []; }
              currentLine.push(segment);
            }
            if (currentLine.length > 0) lines.push(currentLine);
            return lines.map((line, lineIndex) => (
              <Box key={lineIndex}>
                {line.map((seg, i) => (
                  <React.Fragment key={seg.id ?? i}>
                    {i > 0 && <Text dimColor>{statusLineSeparator ?? " · "}</Text>}
                    <Text color={seg.color as any} dimColor={!seg.color}>{seg.text}</Text>
                  </React.Fragment>
                ))}
              </Box>
            ));
          })()}
        </Box>
      )}
    </Box>
  );
});

function renderBufferWithCursor(state: PromptBufferState, placeholder?: string): string {
  const text = state.text || "";
  const cursor = Math.max(0, Math.min(state.cursor, text.length));

  if (text.length === 0 && placeholder) {
    return `\u001B[7m \u001B[27m\u001B[2m ${placeholder}\u001B[22m`;
  }

  if (text.length === 0) return "\u001B[7m \u001B[27m";

  const before = text.slice(0, cursor);
  const at = text[cursor] ?? " ";
  const after = text.slice(cursor + 1);
  return `${before}\u001B[7m${at}\u001B[27m${after}`;
}

export default PromptInput;
