import type { Provider } from "../providers/types.js";
import type { Message } from "../types.js";
import type { ModelEntry } from "./ModelSelector.js";
import type { ThemeContextValue, ThemeDefinition } from "./theme.js";
import type { KeybindingMap, KeybindingConfig, KeybindingAction } from "./keybindings.js";
import type { StatusLineManager } from "./statusline/index.js";

// ── State ──

export interface MutableState {
  conversationHistory: Message[];
  sessionInput: number;
  sessionOutput: number;
  lastContextTokens: number;
  sessionUserInputs: string[];
  modelUsage?: Record<string, { input: number; output: number; cached: number }>;
  posture?: "normal" | "autoApprove" | "plan";
}

// ── Status Bar ──

/** A single segment of the status bar, rendered as an Ink <Text> with these props. */
export interface StatusSegment {
  id?: string;
  text: string;
  bold?: boolean;
  dimColor?: boolean;
  color?: string;
  backgroundColor?: string;
  newLine?: boolean;
}

// ── Tab / Multiplex ──

export interface TabDefinition {
  id: string;
  title: string;
  type: "chat" | "output" | "terminal" | "log" | "custom";
  icon?: string;
  /** Whether this tab can be closed by the user */
  closable: boolean;
  /** Custom metadata */
  meta?: Record<string, unknown>;
}

export interface PaneDefinition {
  id: string;
  direction: "horizontal" | "vertical";
  splitPosition: number; // 0-1 ratio
  tabs: TabDefinition[];
  activeTabId: string;
}

// ── Theme ──

export interface ThemeConfig {
  mode: "dark" | "light" | "auto";
  name?: string;
  overrides?: Partial<ThemeDefinition>;
}

// ── Workflow Integration ──

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  modified: number;
  added: number;
  deleted: number;
  staged: number;
  conflicts: number;
  dirty: boolean;
}

export interface WorkflowIntegrationConfig {
  /** Show git status in the status bar */
  gitStatus: boolean;
  /** Check git status interval in ms (0 = on demand only) */
  gitPollInterval: number;
  /** Show current branch first in status bar */
  gitBranchFirst?: boolean;
  /** Enable git workflow commands (/git) */
  gitCommands: boolean;
  /** Detect build tools from cwd */
  detectBuildTools: boolean;
}

// ── App Context ──

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
  /** Config-driven status line providers (command/module). Undefined when no `statusline` config. */
  statusLineManager?: StatusLineManager;
  getPromptStr: () => string;
  getColorEnabled: () => boolean;

  logSessionEnd: () => Promise<void>;
  onExit: () => void;

  handleSlash: (input: string) => Promise<string[]>;
  getModelEntries: () => ModelEntry[];
  runAgentTurnCore: (input: string, callbacks: AgentBridgeCallbacks, imageUrls?: string[], planMode?: boolean) => Promise<any>;
  resumeSession?: (sessionId: string) => Promise<boolean>;
  showResumeOnStart?: boolean;
  /** One-time notice (e.g. "Resumed <id>") shown in the scrollback on mount. */
  initialNotice?: string;
  /**
   * Prior transcript of a resumed session (from the store), replayed into the
   * scrollback on mount. Empty/undefined for a fresh session. The model already
   * sees these via `mutable.conversationHistory`; this is purely for display.
   */
  initialMessages?: Message[];
  /**
   * Compact the resumed transcript on demand (user picks "Compact" at the
   * resume chooser). Runs the summarizer, persists a non-destructive compaction
   * overlay to the session store (raw log is kept), updates the in-memory
   * history, and returns the compacted messages to replay. Returns null if
   * there was nothing to compact.
   */
  compactResumed?: () => Promise<Message[] | null>;
  restoreCheckpoint?: (hash: string, restoreCode: boolean) => Promise<{ restored: boolean; promptDraft: string }>;

  // ── New: Theme & Keybinding support ──
  theme?: ThemeContextValue;
  keybindings?: KeybindingMap;
  keybindingConfig?: KeybindingConfig;

  // ── New: Multiplex support ──
  tabState?: {
    tabs: TabDefinition[];
    activeTabId: string;
    setActiveTab: (id: string) => void;
    addTab: (tab: TabDefinition) => void;
    closeTab: (id: string) => void;
  };

  // ── New: Workflow integration ──
  workflowConfig?: WorkflowIntegrationConfig;
  gitStatus?: GitStatus | null;
  refreshGitStatus?: () => Promise<void>;
}

// ── Agent Bridge Callbacks ──

export interface AgentBridgeCallbacks {
  onText: (c: string) => void;
  onReasoning?: (c: string) => void;
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
