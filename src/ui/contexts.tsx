/**
 * Heirloom React Contexts — Theme, Keybinding, and Accessibility contexts
 * for the Ink-based TUI. These wire the theme.ts and keybindings.ts
 * infrastructure into React components via context.
 */

import React, { createContext, useContext, useMemo } from "react";
import {
  ThemeContextValue,
  createDefaultTheme,
  resolveTheme,
  type ThemeDefinition,
} from "./theme.js";
import {
  resolveKeybindings,
  type KeybindingMap,
  type KeybindingConfig,
} from "./keybindings.js";

// ── Theme Context ──

export interface ThemeProviderOptions {
  mode?: "dark" | "light" | "auto";
  overrides?: Partial<ThemeDefinition>;
  colorEnabled?: boolean;
}

const ThemeContext = createContext<ThemeContextValue>(createDefaultTheme());

export function ThemeProvider({
  config,
  children,
}: {
  config?: ThemeProviderOptions;
  children: React.ReactNode;
}) {
  const value = useMemo(() => {
    const resolved = resolveTheme({
      mode: config?.mode ?? "dark",
      overrides: config?.overrides,
    });
    const colorEnabled =
      config?.colorEnabled ?? (!!process.stdout.isTTY && !process.env.NO_COLOR);
    return new ThemeContextValue(resolved, colorEnabled);
  }, [config?.mode, JSON.stringify(config?.overrides), config?.colorEnabled]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

// ── Keybinding Context ──

const KeybindingContext = createContext<KeybindingMap>({});

export function KeybindingProvider({
  config,
  children,
}: {
  config?: KeybindingConfig;
  children: React.ReactNode;
}) {
  const value = useMemo(() => resolveKeybindings(config), [config]);
  return (
    <KeybindingContext.Provider value={value}>
      {children}
    </KeybindingContext.Provider>
  );
}

export function useKeybindings(): KeybindingMap {
  return useContext(KeybindingContext);
}

// ── Terminal Info Context (responsive layout) ──

export interface TerminalInfo {
  columns: number;
  rows: number;
}

const TerminalContext = createContext<TerminalInfo>({
  columns: 80,
  rows: 24,
});

export function TerminalProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [info, setInfo] = React.useState<TerminalInfo>(() => ({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }));

  React.useEffect(() => {
    const onResize = () => {
      setInfo({
        columns: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      });
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  return (
    <TerminalContext.Provider value={info}>
      {children}
    </TerminalContext.Provider>
  );
}

export function useTerminalInfo(): TerminalInfo {
  return useContext(TerminalContext);
}

// ── Accessibility Context (screen reader announcements) ──

export interface AccessibilityState {
  announce: (message: string, priority?: "polite" | "assertive") => void;
  lastAnnouncement: string;
  lastPriority: "polite" | "assertive";
}

const AccessibilityContext = createContext<AccessibilityState>({
  announce: () => {},
  lastAnnouncement: "",
  lastPriority: "polite",
});

export function AccessibilityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [lastAnnouncement, setLastAnnouncement] = React.useState("");
  const [lastPriority, setLastPriority] = React.useState<"polite" | "assertive">("polite");

  const announce = React.useCallback(
    (message: string, priority: "polite" | "assertive" = "polite") => {
      setLastAnnouncement(message);
      setLastPriority(priority);
    },
    [],
  );

  const value = useMemo(
    () => ({ announce, lastAnnouncement, lastPriority }),
    [announce, lastAnnouncement, lastPriority],
  );

  return (
    <AccessibilityContext.Provider value={value}>
      {children}
    </AccessibilityContext.Provider>
  );
}

export function useAccessibility(): AccessibilityState {
  return useContext(AccessibilityContext);
}
