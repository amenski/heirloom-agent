import type { Message } from "../../types.js";

/** Marker prefix used to detect (and dedupe) a skill already force-loaded into the conversation. */
export function skillLoadMarker(name: string): string {
  return `[skill: ${name}]`;
}

/** True when `history` already contains a user message force-loading `name`. */
export function isSkillAlreadyLoaded(history: Message[], name: string): boolean {
  const marker = skillLoadMarker(name);
  return history.some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(marker),
  );
}

/** Build the user-role message that force-loads a skill's content into the conversation. */
export function buildSkillLoadMessage(name: string, content: string): Message {
  return {
    role: "user",
    content: `${skillLoadMarker(name)}\nThe user loaded this skill; follow its instructions for the rest of the conversation.\n\n${content}`,
  };
}
