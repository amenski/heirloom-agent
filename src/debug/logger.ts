import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

let debugPath: string | null = null;

export function enableDebug(sessionId: string): void {
  const dir = join(process.cwd(), ".heirloom", "debug");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  debugPath = join(dir, `${sessionId}.jsonl`);
}

export function logRequest(body: Record<string, unknown>): void {
  if (!debugPath) return;
  const entry = JSON.stringify({
    ts: Date.now(),
    type: "request",
    model: body.model,
    messages: body.messages,
    tools: (body.tools as any[])?.map((t: any) => t.function?.name ?? t.name),
    max_tokens: body.max_tokens,
    temperature: body.temperature,
  });
  appendFileSync(debugPath, entry + "\n");
}

export function logResponse(usage: unknown, toolCalls: unknown[]): void {
  if (!debugPath) return;
  const entry = JSON.stringify({
    ts: Date.now(),
    type: "response",
    usage,
    tool_calls: (toolCalls as any[])?.map((tc: any) => ({
      name: tc.function?.name ?? tc.name,
      args: tc.function?.arguments ?? tc.args,
    })),
  });
  appendFileSync(debugPath, entry + "\n");
}
