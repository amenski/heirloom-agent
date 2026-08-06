export const ARGS_SEPARATOR = " | ";
export const ANSI_CLEAR_SCREEN = "[2J[3J[H";
export const PROMPT_PREFIX_WIDTH = 2;
/**
 * Sentinel prefixed onto an echoed user message so OutputArea renders it as a
 * full-width highlighted bar (grey background + "›" chevron), the way Claude
 * Code marks user input. Uses non-printing control chars that never occur in
 * real message text.
 */
export const USER_ECHO_TAG = "\u0001\u0003";

/**
 * Sentinel prefixed onto an echoed slash command (e.g. "/model", "/compact") so
 * OutputArea renders it as a lightweight dim "\u203a" line rather than the
 * highlighted prompt bar. Commands never call the model, so this echo is purely
 * a visible record of what was typed \u2014 it is not counted toward context usage.
 */
export const COMMAND_ECHO_TAG = "\u0001\u0004";
