// Matches the compact grepped <error_analysis> block that run_bash embeds in
// content on real failures (non-zero exit + non-empty stderr, src/tools/bash.ts
// buildErrorAnalysis). Extracted verbatim: the block is already inside the T12
// untrusted delimiters, so no re-wrapping is needed when it is appended.
const ERROR_ANALYSIS_RE = /<error_analysis>[\s\S]*?<\/error_analysis>/;

export class ErrorReflector {
  private turnRetries: number = 0;
  private totalRetries: number = 0;
  private maxTurnRetries: number = 1;
  private maxTotalRetries: number = 3;

  canRetry(toolName: string, errorMsg: string): boolean {
    if (errorMsg.includes("Permission denied")) return false;
    if (this.turnRetries >= this.maxTurnRetries) return false;
    if (this.totalRetries >= this.maxTotalRetries) return false;
    this.turnRetries++;
    this.totalRetries++;
    return true;
  }

  formatError(toolName: string, errorMsg: string, content?: string): string {
    let message = `Your ${toolName} call failed: ${errorMsg}. Try a different approach.`;
    // The retry path replaces tool content with `Error: <err>`, which would
    // hide the grepped error lines — append the block so the model sees them.
    const analysis = content?.match(ERROR_ANALYSIS_RE)?.[0];
    if (analysis) message += `\n${analysis}`;
    return message;
  }

  resetTurn(): void {
    this.turnRetries = 0;
  }
}
