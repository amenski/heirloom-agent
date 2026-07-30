export interface ModelUsageEntry {
  input: number;
  output: number;
  cached?: number;
}

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

function padLeft(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - text.length)) + text;
}

export function buildExitSummaryText(usagePerModel: Record<string, ModelUsageEntry>): string {
  const entries = Object.entries(usagePerModel);
  if (entries.length === 0) return "";

  const cols = { model: 24, reqs: 8, input: 16, output: 16, cached: 14 };
  const totalWidth = cols.model + cols.reqs + cols.input + cols.output + cols.cached + 7;

  const lines: string[] = [];
  const C = "│";

  lines.push("\u250C" + "\u2500".repeat(totalWidth) + "\u2510");

  const header = `${C} ${padRight("Model", cols.model)}${C}${padLeft("Reqs", cols.reqs - 1)} ${C}${padLeft("Input Tokens", cols.input - 1)} ${C}${padLeft("Output Tokens", cols.output - 1)} ${C}${padLeft("Cached Tokens", cols.cached - 1)} ${C}`;
  lines.push(header);

  lines.push("\u251C" + "\u2500".repeat(totalWidth) + "\u2524");

  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;

  for (const [model, usage] of entries) {
    totalInput += usage.input;
    totalOutput += usage.output;
    totalCached += usage.cached ?? 0;
    const row = `${C} ${padRight(model.length > cols.model + 1 ? model.slice(0, cols.model + 1) : model, cols.model + 1)}${C} ${padLeft("-", cols.reqs - 1)} ${C} ${padLeft(usage.input.toLocaleString("en-US"), cols.input - 1)} ${C} ${padLeft(usage.output.toLocaleString("en-US"), cols.output - 1)} ${C} ${padLeft((usage.cached ?? 0).toLocaleString("en-US"), cols.cached - 1)} ${C}`;
    lines.push(row);
  }

  if (entries.length > 1) {
    lines.push("\u251C" + "\u2500".repeat(totalWidth) + "\u2524");
    const totalRow = `${C} ${padRight("TOTAL", cols.model + 1)}${C} ${padLeft("-", cols.reqs - 1)} ${C} ${padLeft(totalInput.toLocaleString("en-US"), cols.input - 1)} ${C} ${padLeft(totalOutput.toLocaleString("en-US"), cols.output - 1)} ${C} ${padLeft(totalCached.toLocaleString("en-US"), cols.cached - 1)} ${C}`;
    lines.push(totalRow);
  }

  lines.push("\u2514" + "\u2500".repeat(totalWidth) + "\u2518");

  return lines.join("\n");
}

export function buildResumeHintText(sessionId: string, colorEnabled: boolean): string {
  const cmd = `heirloom --resume ${sessionId}`;
  if (colorEnabled) {
    return `\x1b[90mResume:\x1b[0m ${cmd}`;
  }
  return `Resume: ${cmd}`;
}
