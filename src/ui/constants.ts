export const ARGS_SEPARATOR = " | ";
export const ANSI_CLEAR_SCREEN = "[2J[3J[H";
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

/**
 * How many committed output lines stay individually rendered in the live frame.
 *
 * Ink re-lays-out every live element each frame, so cost grew with session
 * length: measured 4ms per spinner tick at 200 lines, 62ms at 4k, 197ms at 8k —
 * past the 80ms tick budget the ticks queue faster than they drain and the UI
 * locks up. Older lines are folded into ONE element rather than dropped: there
 * is no <Static> flush, so this array is the only copy of the transcript and
 * discarding it would lose the scrollback for good.
 *
 * 400 is well beyond one screenful, so nothing on screen is ever folded.
 */
export const LIVE_LINE_BUDGET = 400;
