import type { StatusSegment, SessionInfo } from "./types.js";

export type SegmentProvider = (info: SessionInfo | null) => StatusSegment[];

export class StatusLineManager {
  private providers: SegmentProvider[] = [];

  addProvider(provider: SegmentProvider): void {
    this.providers.push(provider);
  }

  build(info: SessionInfo | null): StatusSegment[] {
    const segments: StatusSegment[] = [];
    for (const provider of this.providers) {
      segments.push(...provider(info));
    }
    return segments;
  }
}

export function createDefaultProviders(): SegmentProvider[] {
  return [
    (info) => {
      if (!info) return [{ id: "mode", text: "chat" }];
      return [{ id: "mode", text: info.activeSessionId ? "chat" : "idle" }];
    },
    (info) => {
      if (!info || !info.model) return [];
      return [{ id: "model", text: info.model }];
    },
    (info) => {
      if (!info || info.totalTokens === 0) return [];
      const pct = info.maxContextTokens > 0 ? Math.round((info.activeTokens / info.maxContextTokens) * 100) : 0;
      return [{ id: "ctx", text: `ctx ${pct}%` }];
    },
  ];
}
