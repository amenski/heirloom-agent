/**
 * Resume replay — turn a loaded session transcript back into the exact
 * scrollback lines a live turn would have produced.
 *
 * The model already sees the resumed messages via conversationHistory; this is
 * purely visual. It reuses the live formatters (formatToolCallHeader,
 * formatToolResultPreview) and the USER_ECHO_TAG gutter so a resumed transcript
 * is indistinguishable from one that just streamed. Read-only tools that are
 * hidden live (SILENT_TOOLS) stay hidden here too, so replay never shows *more*
 * than the original session did.
 */

import type { Message } from "../../types.js";
import {
  formatToolCallHeader,
  formatToolResultPreview,
  SILENT_TOOLS,
} from "../ToolCallFormatter.js";
import { USER_ECHO_TAG } from "../constants.js";

const withBullet = (line: string): string => {
  const [first, ...rest] = line.split("\n");
  return [`● ${first}`, ...rest].join("\n");
};

const dim = (colorEnabled: boolean, s: string): string =>
  colorEnabled ? `\x1b[2m${s}\x1b[0m` : s;

/**
 * Build the scrollback lines for a resumed transcript. Silent (context-only)
 * tool calls and their results are dropped, matching live rendering.
 */
export function buildReplayLines(messages: Message[], colorEnabled: boolean): string[] {
  const out: string[] = [];
  // Tool-call ids whose call header was suppressed (silent tool) — their result
  // message must be suppressed too, so the replay stays consistent.
  const silentCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "system") {
      // A compaction summary is the only system message worth surfacing; the
      // per-turn system prompt is noise. Show summaries dimmed.
      if (msg.content.startsWith("[Previous conversation summary]")) {
        out.push("");
        out.push(dim(colorEnabled, msg.content));
        out.push("");
      }
      continue;
    }

    if (msg.role === "user") {
      // A persisted compaction overlay is stored as a user message; render it as
      // a dim summary rather than user input.
      if (msg.content.startsWith("[Previous conversation summary]")) {
        out.push("");
        out.push(dim(colorEnabled, msg.content));
        out.push("");
        continue;
      }
      out.push("");
      out.push(USER_ECHO_TAG + msg.content);
      out.push("");
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.content && msg.content.trim() !== "") {
        out.push(withBullet(msg.content));
      }
      for (const call of msg.toolCalls ?? []) {
        if (SILENT_TOOLS.has(call.name)) {
          silentCallIds.add(call.id);
          continue;
        }
        out.push("");
        out.push(formatToolCallHeader(call.name, call.arguments));
      }
      continue;
    }

    if (msg.role === "tool") {
      if (silentCallIds.has(msg.toolCallId)) continue;
      const content = msg.content ?? "";
      if (content.trim() === "") continue;
      const isError =
        content.startsWith("PERMISSION_DENIED") || content.startsWith("COMMAND_FAILED");
      for (const line of formatToolResultPreview(content)) {
        out.push(
          colorEnabled ? (isError ? `\x1b[31m${line}\x1b[0m` : `\x1b[2m${line}\x1b[0m`) : line,
        );
      }
      continue;
    }
  }

  return out;
}
