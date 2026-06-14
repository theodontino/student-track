import OpenAI from "openai";

/** Creates the configured OpenAI-compatible client and fails fast without a key. */
export function createLLMClient() {
  const apiKey = process.env.LLM_API_KEY;
  const baseURL = process.env.LLM_API_BASE_URL || "https://api.openai.com/v1";

  if (!apiKey) {
    throw new Error("LLM_API_KEY is not set in environment variables");
  }

  return new OpenAI({
    apiKey,
    baseURL,
  });
}

/** Returns the configured model name without performing a network request. */
export function getLLMModel(): string {
  return process.env.LLM_MODEL || "gpt-4o-mini";
}
