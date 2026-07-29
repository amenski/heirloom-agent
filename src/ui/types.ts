import type { Provider } from "../providers/types.js";
import type { Message } from "../types.js";
import type { ModelEntry } from "./ModelSelector.js";

export interface MutableState {
  conversationHistory: Message[];
  sessionInput: number;
  sessionOutput: number;
  lastContextTokens: number;
  sessionUserInputs: string[];
}

/** A single segment of the status bar, rendered as an Ink <Text> with these props. */
export interface StatusSegment {
  text: string;
  bold?: boolean;
  dimColor?: boolean;
  color?: string;
}

export interface AppContext {
  mutable: MutableState;

  getProvider: () => Provider;
  sessionId: string;
  activeMode: any;
  permissions: any;
  toolRegistry: any;
  compactor: any;
  diagnostics: any;
  skills: any[];
  memoryInjection: string | undefined;
  memoryStore: any;
  sessionStore: any;
  checkpoints: any;
  modeLoader: any;
  skillLoader: any;
  providerName: string;
  activeModel: string | undefined;

  provideAbortController: () => AbortController;
  renewAbortController: () => void;

  processAtMentions: (input: string) => Promise<string>;
  completer: (line: string) => [string[], string];

  buildStatusBar: () => StatusSegment[];
  cycleApprovalMode: () => void;
  getPromptStr: () => string;
  getColorEnabled: () => boolean;

  logSessionEnd: () => Promise<void>;
  onExit: () => void;

  handleSlash: (input: string) => Promise<string[]>;
  getModelEntries: () => ModelEntry[];
  runAgentTurnCore: (input: string, callbacks: AgentBridgeCallbacks) => Promise<any>;
}

export interface AgentBridgeCallbacks {
  onText: (c: string) => void;
  onToolStart: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: { content: string; error?: string }) => void;
  onDiagnostic: (m: string) => void;
  onRetry: (m: string) => void;
  onCompacted: (m: string) => void;
  onLoopDetected: (m: string) => void;
  onMaxTurns: () => void;
  onUsage: (input: number, output: number) => void;
  onNewMessages: (userInput: string, newMessages: Message[]) => Promise<void>;
  onHistoryUpdate: (messages: Message[]) => void;
  askUser: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
}
