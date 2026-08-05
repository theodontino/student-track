import { createLLMClient, getLLMCompletionOptions, getLLMModel } from "./llm";
import { SYSTEM_PROMPT, REVIEW_PROMPT, NAME_FIX_SYSTEM_PROMPT } from "./prompts";
import type { AttentionSignalCandidate } from "./attention-labels";
import type { TeacherIntervention } from "@/lib/types";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  DraftReviewResultSchema,
  DraftStructuredResultSchema,
  NameFixPayloadSchema,
} from "@/lib/contracts/classroom-parse";

export interface ParsedStudent {
  name: string;
  scores: { A: number | null; B: number | null; C: number | null };
  events: string[];
  communication: { type: string; summary: string } | null;
  present?: boolean;
  attentionSignals?: AttentionSignalCandidate[];
  teacherInterventions?: TeacherIntervention[];
}

export interface ParseResult {
  students: ParsedStudent[];
  alert_suggestion: string;
}

interface ReviewResult {
  is_valid: boolean;
  issues: string[];
  suggestions: string[];
  revised_scores: Record<string, Record<string, number | null>>;
  revised_events: Record<string, string[]>;
  revised_teacher_interventions?: Record<string, TeacherIntervention[]>;
}

// v0.6: LLM call with retry (up to 2 retries on timeout/error)
async function llmCall(
  messages: ChatCompletionMessageParam[],
  maxRetries = 2
): Promise<string> {
  const client = createLLMClient();
  const model = getLLMModel();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model, messages, ...getLLMCompletionOptions(undefined, 16384),
      });
      const content = resp.choices[0]?.message?.content?.trim() || "";
      if (resp.choices[0]?.finish_reason === "length") {
        throw new Error("LLM response truncated (token limit)");
      }
      return content;
    } catch (error: unknown) {
      lastErr = error;
      if (attempt < maxRetries) {
        console.warn(`[llmCall] retry ${attempt + 1}/${maxRetries + 1}: ${errorMessage(error, "unknown error")}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("LLM failed after retries");
}

/** v0.13: stream LLM call — calls onChunk for each token delta */
export async function llmCallStream(
  messages: ChatCompletionMessageParam[],
  onChunk: (delta: string) => void,
  maxRetries = 2
): Promise<string> {
  const client = createLLMClient();
  const model = getLLMModel();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const stream = await client.chat.completions.create({
        model, messages, ...getLLMCompletionOptions(undefined, 16384), stream: true,
      });
      let content = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || "";
        if (delta) { content += delta; onChunk(delta); }
      }
      if (!content.trim()) throw new Error("LLM returned empty response");
      return content.trim();
    } catch (error: unknown) {
      lastErr = error;
      if (attempt < maxRetries) {
        console.warn(`[llmCall] retry ${attempt + 1}/${maxRetries + 1}: ${errorMessage(error, "unknown error")}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("LLM failed after retries");
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface NameCorrection {
  original: string;
  corrected: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface NameFixResult {
  correctedText: string;
  corrections: NameCorrection[];
}

export function applyNameCorrections(
  rawText: string,
  studentNames: string[],
  corrections: NameCorrection[],
): NameFixResult {
  const eligible = corrections.filter(
    (item) => studentNames.includes(item.corrected) && rawText.includes(item.original),
  );
  const byOriginal = new Map<string, Map<string, NameCorrection>>();
  for (const item of eligible) {
    const byCorrected = byOriginal.get(item.original) ?? new Map<string, NameCorrection>();
    if (!byCorrected.has(item.corrected)) byCorrected.set(item.corrected, item);
    byOriginal.set(item.original, byCorrected);
  }

  const valid = [...byOriginal.values()]
    .filter((byCorrected) => byCorrected.size === 1)
    .map((byCorrected) => byCorrected.values().next().value as NameCorrection);
  const highConfidence = valid
    .filter((item) => item.confidence === "high")
    .sort((left, right) => right.original.length - left.original.length);
  const replacements = highConfidence.map((item) => [item.original, item.corrected] as const);
  const correctedText = replacements.length
    ? rawText.replace(
      new RegExp(replacements.map(([original]) => escapeRegExp(original)).join("|"), "g"),
      (match) => replacements.find(([original]) => original === match)?.[1] ?? match,
    )
    : rawText;

  return { correctedText, corrections: valid };
}

/** v0.13: pre-correct student names in raw text via LLM */
export async function correctNamesWithLLM(
  rawText: string,
  studentNames: string[]
): Promise<NameFixResult> {
  const userPrompt = `学生名单：${studentNames.join("、")}

原始文本：
${rawText}`;

  const content = await llmCall([
    { role: "system", content: NAME_FIX_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ], 1);

  try {
    const parsed = NameFixPayloadSchema.parse(parseJSONValue(content));
    return applyNameCorrections(
      rawText,
      studentNames,
      parsed.corrections.map((item): NameCorrection => ({ ...item, reason: item.reason ?? "" })),
    );
  } catch {
    return { correctedText: rawText, corrections: [] };
  }
}

/**
 * Call LLM to parse teacher's natural language input
 */
export async function parseInput(rawText: string, studentNames: string[]): Promise<ParseResult> {
  const userPrompt = `已知学生名单：${studentNames.join("、")}

教师的输入文本：
${rawText}

请按照 System Prompt 的要求，分析文本并返回 JSON。`;

  const content = await llmCall([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);
  return DraftStructuredResultSchema.parse(parseJSONValue(content));
}

/**
 * Call LLM to self-review the parsed result
 */
export async function reviewParsed(rawText: string, parsedResult: ParseResult): Promise<ReviewResult> {
  const userPrompt = REVIEW_PROMPT
    .replace("{rawText}", rawText)
    .replace("{parsedResult}", JSON.stringify(parsedResult, null, 2));

  const content = await llmCall([{ role: "user", content: userPrompt }]);
  return DraftReviewResultSchema.parse(parseJSONValue(content));
}

/**
 * Fuzzy-match LLM-returned name to exact DB student name.
 */
export function fuzzyMatchName(llmName: string, candidates: string[]): string | null {
  const input = llmName.trim();
  if (!input || candidates.length === 0) return null;

  if (candidates.includes(input)) return input;
  const noSuffix = input.replace(/同学|小朋友|老师/g, "").trim();
  if (noSuffix && candidates.includes(noSuffix)) return noSuffix;

  const substringMatches = candidates.filter((candidate) => (
    candidate.includes(input) || input.includes(candidate)
    || Boolean(noSuffix && (candidate.includes(noSuffix) || noSuffix.includes(candidate)))
  ));
  if (substringMatches.length === 1) return substringMatches[0];

  const scored: Array<{ candidate: string; score: number }> = [];
  for (const c of candidates) {
    if (c.length < 2 || input.length < 2) continue;
    const overlap = [...input].filter((ch) => c.includes(ch)).length;
    const score = overlap / Math.max(input.length, c.length);
    scored.push({ candidate: c, score });
  }
  scored.sort((left, right) => right.score - left.score);
  const best = scored[0];
  const second = scored[1];
  if (best && best.score > 0.6 && (!second || best.score - second.score >= 0.2)) return best.candidate;
  return null;
}

/** Applies deterministic fuzzy matching after LLM parsing without mutating the input. */
export function correctNames(result: ParseResult, studentNames: string[]): ParseResult {
  const corrected = result.students.map((stu) => {
    const match = fuzzyMatchName(stu.name, studentNames);
    if (match && match !== stu.name) {
      return { ...stu, name: match };
    }
    return stu;
  });
  return { ...result, students: corrected };
}

function parseJSONValue(text: string): unknown {
  let cleaned = text.trim();
  if (!cleaned) throw new Error("LLM returned empty response");
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/```\w*\n?/, "").replace(/\n?```$/, "");
  }
  return JSON.parse(cleaned) as unknown;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
