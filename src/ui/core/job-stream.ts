/**
 * Coalesce a background job's output chunks into one string per ~200ms
 * cadence, so a chatty job cannot turn into a row-per-chunk render storm in
 * the Static transcript (plan §3 — live output for model-started jobs). Pure
 * and timer-free: the caller owns the timer and calls flush().
 */
export class JobOutputCoalescer {
  private pending: string[] = [];

  constructor(private readonly emit: (text: string) => void) {}

  push(chunk: string): void {
    if (chunk) this.pending.push(chunk);
  }

  /** Join all buffered chunks into one string and emit it. No-op when empty. */
  flush(): void {
    if (this.pending.length === 0) return;
    const text = this.pending.join("");
    this.pending = [];
    this.emit(text);
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }
}
