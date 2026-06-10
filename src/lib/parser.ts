import { createLLMClient, getLLMModel } from "./llm";
import { SYSTEM_PROMPT, REVIEW_PROMPT, NAME_FIX_SYSTEM_PROMPT } from "./prompts";

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

// v0.6: LLM call with retry (up to 2 retries on timeout/error)
async function llmCall(
  messages: { role: string; content: string }[],
  temperature: number,
  maxRetries = 2
): Promise<string> {
  const client = createLLMClient();
  const model = getLLMModel();
  let lastErr: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model, messages: messages as any, temperature, max_tokens: 16384,
      });
      const content = resp.choices[0]?.message?.content?.trim() || "";
      if (resp.choices[0]?.finish_reason === "length") {
        throw new Error("LLM response truncated (token limit)");
      }
      return content;
    } catch (e: any) {
      lastErr = e;
      if (attempt < maxRetries) {
        console.warn(`[llmCall] retry ${attempt + 1}/${maxRetries + 1}:`, e.message);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr || new Error("LLM failed after retries");
}

/** v0.13: stream LLM call — calls onChunk for each token delta */
export async function llmCallStream(
  messages: { role: string; content: string }[],
  temperature: number,
  onChunk: (delta: string) => void,
  maxRetries = 2
): Promise<string> {
  const client = createLLMClient();
  const model = getLLMModel();
  let lastErr: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const stream = await client.chat.completions.create({
        model, messages: messages as any, temperature, max_tokens: 16384, stream: true,
      });
      let content = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || "";
        if (delta) { content += delta; onChunk(delta); }
      }
      if (!content.trim()) throw new Error("LLM returned empty response");
      return content.trim();
    } catch (e: any) {
      lastErr = e;
      if (attempt < maxRetries) {
        console.warn(`[llmCall] retry ${attempt + 1}/${maxRetries + 1}:`, e.message);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr || new Error("LLM failed after retries");
}

/** v0.13: pre-correct student names in raw text via LLM */
export async function correctNamesWithLLM(
  rawText: string,
  studentNames: string[]
): Promise<string> {
  const userPrompt = `学生名单：${studentNames.join("、")}

原始文本：
${rawText}

修正后文本：`;

  return await llmCall([
    { role: "system", content: NAME_FIX_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ], 0.1, 1);
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
  ], 0.3);
  return parseJSON(content, "parseInput") as ParseResult;
}

/**
 * Call LLM to self-review the parsed result
 */
export async function reviewParsed(rawText: string, parsedResult: ParseResult): Promise<ReviewResult> {
  const userPrompt = REVIEW_PROMPT
    .replace("{rawText}", rawText)
    .replace("{parsedResult}", JSON.stringify(parsedResult, null, 2));

  const content = await llmCall([{ role: "user", content: userPrompt }], 0.2);
  return parseJSON(content, "reviewParsed") as ReviewResult;
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

  for (const c of candidates) {
    if (c.includes(input) || input.includes(c)) return c;
    if (noSuffix && (c.includes(noSuffix) || noSuffix.includes(c))) return c;
  }

  let bestMatch: string | null = null, bestScore = 0;
  for (const c of candidates) {
    if (c.length < 2 || input.length < 2) continue;
    const overlap = [...input].filter((ch) => c.includes(ch)).length;
    const score = overlap / Math.max(input.length, c.length);
    if (score > 0.6 && score > bestScore) { bestScore = score; bestMatch = c; }
  }
  return bestMatch;
}

export function correctNames(result: ParseResult, studentNames: string[]): ParseResult {
  const corrected = result.students.map((stu) => {
    const match = fuzzyMatchName(stu.name, studentNames);
    if (match && match !== stu.name) {
      console.log(`[fuzzyMatch] Corrected "${stu.name}" → "${match}"`);
      return { ...stu, name: match };
    }
    return stu;
  });
  return { ...result, students: corrected };
}

function parseJSON(text: string, caller: string): object {
  let cleaned = text.trim();
  if (!cleaned) throw new Error(`[${caller}] LLM returned empty response`);
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/```\w*\n?/, "").replace(/\n?```$/, "");
  }
  try { return JSON.parse(cleaned); } catch (e) {
    const preview = cleaned.length > 500 ? cleaned.slice(0, 500) + "..." : cleaned;
    console.error(`[${caller}] JSON parse failed:\n${preview}`);
    throw e;
  }
}
