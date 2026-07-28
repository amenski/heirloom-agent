import type { Provider, StreamEvent } from "./types.js";

export interface RetryableError extends Error {
  status?: number;
  retryable: boolean;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createRetryingProvider(inner: Provider): Provider {
  const name = inner.name;
  return {
    name,
    async *streamChat(messages, tools, options) {
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          yield* inner.streamChat(messages, tools, options);
          return;
        } catch (err: any) {
          lastError = err;
          const status = err.status ?? err.statusCode;
          const retryable = status ? isRetryableStatus(status) : true;

          if (!retryable || attempt >= 2) {
            throw err;
          }

          const delay = Math.pow(2, attempt) * 1000;
          console.error(`  [provider error, retry ${attempt + 1}/3: ${err.message}]`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw lastError!;
    },
  };
}
