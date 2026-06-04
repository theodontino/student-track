import OpenAI from "openai";

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

export function getLLMModel(): string {
  return process.env.LLM_MODEL || "gpt-4o-mini";
}
