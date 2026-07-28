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

  formatError(toolName: string, errorMsg: string): string {
    return `Your ${toolName} call failed: ${errorMsg}. Try a different approach.`;
  }

  resetTurn(): void {
    this.turnRetries = 0;
  }
}
