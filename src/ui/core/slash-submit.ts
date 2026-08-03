import { findExactSlashCommand, type SlashCommandItem } from "./slash-commands.js";

export type SlashSubmitDecision =
  | { action: "routeKind"; kind: SlashCommandItem }
  | { action: "submitText"; text: string };

/**
 * Decide how an Enter submission of `/…` text should be routed.
 *
 * A bare command (the whole line IS a known command, no args) routes through
 * the command's kind handler (opens pickers, cycles modes, quits, etc.).
 * Anything else starting with "/" is submitted as full text so args survive
 * ("/raw normal", "/permissions history", "/clear foo") and reach App's slash
 * handler intact. Non-slash submissions and busy submissions return null, the
 * plain-message path (App enqueues while a turn is active).
 */
export function resolveSlashSubmit(
  trimmed: string,
  slashItems: SlashCommandItem[],
  busy: boolean,
): SlashSubmitDecision | null {
  if (busy || !trimmed.startsWith("/")) return null;
  const firstWord = trimmed.split(/\s+/, 1)[0];
  const exactMatch = findExactSlashCommand(slashItems, firstWord);
  if (exactMatch && trimmed === firstWord) return { action: "routeKind", kind: exactMatch };
  return { action: "submitText", text: trimmed };
}
