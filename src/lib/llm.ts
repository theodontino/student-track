import OpenAI from "openai";
import { getEffectiveLLMSettings, type LLMProfileRole } from "./llm-settings";
import { llmCacheFetch } from "@/services/llm-cache-service";

/** Creates the configured OpenAI-compatible client and fails fast without a key. */
export function createLLMClient(role?: LLMProfileRole) {
  const { apiKey, apiBaseUrl } = getEffectiveLLMSettings(role);

  if (!apiKey) {
    throw new Error("LLM API Key 未设置，请在系统设置中配置");
  }

  return new OpenAI({
    apiKey,
    baseURL: apiBaseUrl,
    fetch: (input, init) => llmCacheFetch(input, init, role ?? "default"),
  });
}

/** Returns the configured model name without performing a network request. */
export function getLLMModel(role?: LLMProfileRole): string {
  return getEffectiveLLMSettings(role).model;
}

/** Shared completion limits for every Student Track LLM caller. */
export function getLLMCompletionOptions(
  role: LLMProfileRole | undefined,
  fallbackMaxTokens: number,
  defaultReasoning = false,
) {
  const settings = getEffectiveLLMSettings(role);
  const reasoningEnabled = settings.reasoningEnabled ?? defaultReasoning;
  return {
    max_tokens: settings.maxTokens ?? fallbackMaxTokens,
    ...(reasoningEnabled ? { reasoning_effort: settings.reasoningEffort ?? "low" } : {}),
  };
}
