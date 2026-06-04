import { createLLMClient, getLLMModel } from "./llm";
import { SYSTEM_PROMPT, REVIEW_PROMPT } from "./prompts";

interface ParsedStudent {
  name: string;
  scores: { A: number | null; B: number | null; C: number | null };
  events: string[];
  communication: { type: string; summary: string } | null;
}

interface ParseResult {
  students: ParsedStudent[];
  alert_suggestion: string;
}

interface ReviewResult {
  is_valid: boolean;
  issues: string[];
  suggestions: string[];
  revised_scores: Record<string, { A: number | null; B: number | null; C: number | null }>;
  revised_events: Record<string, string[]>;
}

/**
 * Call LLM to parse teacher's natural language input
 */
export async function parseInput(rawText: string, studentNames: string[]): Promise<ParseResult> {
  const client = createLLMClient();
  const model = getLLMModel();

  const userPrompt = `已知学生名单：${studentNames.join("、")}

教师的输入文本：
${rawText}

请按照 System Prompt 的要求，分析文本并返回 JSON。`;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 16384,
  });

  const choice = response.choices[0];
  const content = choice?.message?.content?.trim() || "";
  const finishReason = choice?.finish_reason;

  if (finishReason === "length") {
    console.error("[parseInput] LLM response truncated (finish_reason=length). Content preview:", content.slice(0, 500));
    throw new Error("LLM response was truncated due to token limit");
  }

  return parseJSON(content, "parseInput") as ParseResult;
}

/**
 * Call LLM to self-review the parsed result
 */
export async function reviewParsed(rawText: string, parsedResult: ParseResult): Promise<ReviewResult> {
  const client = createLLMClient();
  const model = getLLMModel();

  const userPrompt = REVIEW_PROMPT
    .replace("{rawText}", rawText)
    .replace("{parsedResult}", JSON.stringify(parsedResult, null, 2));

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 16384,
  });

  const choice = response.choices[0];
  const content = choice?.message?.content?.trim() || "";
  const finishReason = choice?.finish_reason;

  if (finishReason === "length") {
    console.error("[reviewParsed] LLM response truncated (finish_reason=length). Content preview:", content.slice(0, 500));
    throw new Error("LLM review response was truncated due to token limit");
  }

  return parseJSON(content, "reviewParsed") as ReviewResult;
}

/**
 * Safely parse JSON from LLM response, stripping markdown code fences if present
 */
function parseJSON(text: string, caller: string): object {
  let cleaned = text.trim();

  if (!cleaned) {
    throw new Error(`[${caller}] LLM returned empty response`);
  }

  // Remove markdown code fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/```\w*\n?/, "").replace(/\n?```$/, "");
  }

  try {
    return JSON.parse(cleaned);
  } catch (parseError) {
    const preview = cleaned.length > 500 ? cleaned.slice(0, 500) + "..." : cleaned;
    console.error(`[${caller}] Failed to parse JSON. Content preview:\n${preview}`);
    throw parseError;
  }
}
