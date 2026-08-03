import type { Provider } from "../providers/types.js";

/**
 * Streams a short, plain-language explanation of a pending tool action for the
 * permission prompt (the Ctrl+E affordance). This is PURELY informational: it
 * never influences the allow/ask/deny decision, which stays deterministic in
 * PermissionEngine. The model only describes what the action does and its
 * risk — it is never asked "is this safe?" and its output never gates
 * execution. Mirrors Claude Code's Ctrl+E, where the model enriches the
 * explanation but the rule engine owns the decision.
 */
export async function* explainToolAction(
  provider: Provider,
  toolName: string,
  subject: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const system =
    "You explain a single pending developer-tool action to a user deciding whether to approve it. " +
    "Reply in at most 3 short sentences, plain language, no preamble. " +
    "Say concretely what the action does, then flag any risk (data loss, network egress, secrets, irreversibility) if present. " +
    "If it is a routine read-only or low-risk action, say so briefly. Do not tell the user what to choose.";

  const user = `Tool: ${toolName}\nAction: ${subject || "(no subject)"}`;

  for await (const ev of provider.streamChat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    [],
    { temperature: 0, maxTokens: 200, signal },
  )) {
    if (ev.type === "text_delta") yield ev.content;
  }
}
