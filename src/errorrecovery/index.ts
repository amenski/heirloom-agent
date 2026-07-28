export class ErrorRecovery {
  private maxFormatRetries = 2;
  private formatRetryCount = 0;

  handleParseError(rawArgs: string): string | null {
    if (this.formatRetryCount >= this.maxFormatRetries) return null;
    this.formatRetryCount++;
    return `Your last response had malformed tool arguments. The arguments must be valid JSON:\n\n${rawArgs.slice(0, 500)}\n\nPlease retry with correct JSON format.`;
  }

  handleFatalError(err: Error): string {
    return `A fatal error occurred: ${err.message}. The conversation state has been preserved.`;
  }

  reset(): void {
    this.formatRetryCount = 0;
  }
}
