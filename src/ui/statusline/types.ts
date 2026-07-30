export interface StatusSegment {
  id: string;
  text: string;
  color?: string;
  newLine?: boolean;
}

export interface SessionInfo {
  activeSessionId: string | null;
  messageCount: number;
  requestCount: number;
  totalTokens: number;
  activeTokens: number;
  maxContextTokens: number;
  model: string;
  thinkingEnabled: boolean;
  reasoningEffort: string | undefined;
  toolUsage: Record<string, number>;
}
