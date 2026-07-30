export type LoadingTextInput = {
  startedAt: number | null;
  formattedTokens?: string;
  now: number;
};

const STALL_THRESHOLD_MS = 3000;

/** Builds the "thinking..." status text, adding elapsed time + token count once a turn stalls past the threshold. */
export function buildLoadingText(input: LoadingTextInput): string {
  const { startedAt, formattedTokens, now } = input;

  if (startedAt === null) {
    return "Thinking...";
  }

  const elapsedMs = Math.max(0, now - startedAt);
  if (elapsedMs < STALL_THRESHOLD_MS) {
    return "Thinking...";
  }

  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const tokens = formattedTokens || "0";
  return `Thinking... (${elapsedSeconds}s) · ↓ ${tokens} tokens`;
}
