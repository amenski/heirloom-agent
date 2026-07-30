import type { ToolDef } from "../types.js";
import type { ToolHandler, AskQuestionItem } from "./types.js";
import type { ToolRegistry } from "./registry.js";

function escapeAnswerPart(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}

export function formatAskUserQuestionAnswers(answers: Record<string, string>): string {
  const answersText = Object.entries(answers)
    .map(([question, answer]) => `"${escapeAnswerPart(question)}"="${escapeAnswerPart(answer)}"`)
    .join(", ");
  return `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`;
}

export function formatAskUserQuestionDecline(): string {
  return "The user declined to answer the questions. Continue with the available context, or ask again if the information is required.";
}

const askUserQuestionHandler: ToolHandler = async (args, ctx) => {
  const questions = normalizeQuestions((args as { questions?: unknown }).questions);
  if (questions.length === 0) {
    return { content: "Error: at least one question with non-empty options is required.", error: "invalid_questions" };
  }
  if (!ctx.askQuestion) {
    return { content: "Error: interactive questions are not supported in this context.", error: "unsupported" };
  }

  const answers = await ctx.askQuestion(questions);
  if (!answers) {
    return { content: formatAskUserQuestionDecline() };
  }
  return { content: formatAskUserQuestionAnswers(answers) };
};

function normalizeQuestions(raw: unknown): AskQuestionItem[] {
  if (!Array.isArray(raw)) return [];
  const questions: AskQuestionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const question = typeof (item as { question?: unknown }).question === "string"
      ? (item as { question: string }).question.trim() : "";
    const rawOptions = (item as { options?: unknown }).options;
    if (!question || !Array.isArray(rawOptions) || rawOptions.length === 0) continue;
    const options = rawOptions
      .map((o) => normalizeOption(o))
      .filter((o): o is { label: string; description?: string } => Boolean(o));
    if (options.length === 0) continue;
    const multiSelect = typeof (item as { multiSelect?: unknown }).multiSelect === "boolean"
      ? (item as { multiSelect: boolean }).multiSelect : undefined;
    questions.push({ question, multiSelect, options });
  }
  return questions;
}

function normalizeOption(raw: unknown): { label: string; description?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const label = typeof (raw as { label?: unknown }).label === "string" ? (raw as { label: string }).label.trim() : "";
  if (!label) return null;
  const description = typeof (raw as { description?: unknown }).description === "string"
    ? (raw as { description: string }).description.trim() : "";
  return { label, description: description || undefined };
}

const askUserQuestionDef: ToolDef = {
  name: "ask_user_question",
  description:
    "Ask the user one or more multiple-choice questions when you need clarification, a decision, or a preference before proceeding. " +
    "Each question offers a fixed set of options; set multiSelect: true if more than one option may apply. " +
    "Use sparingly, only when the ambiguity genuinely blocks progress.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "One or more questions to ask, each with 2-4 options.",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            multiSelect: { type: "boolean" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

export function registerAskUserQuestion(registry: ToolRegistry): void {
  registry.register({ def: askUserQuestionDef, handler: askUserQuestionHandler, groups: ["read", "edit", "command", "mcp", "workflow"] });
}
