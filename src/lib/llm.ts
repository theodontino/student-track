import OpenAI from "openai";
import { getEffectiveLLMSettings, type LLMProfileRole } from "./llm-settings";
import { llmCacheFetch } from "@/services/llm-cache-service";

export type LLMReasoningEffort = "none" | "low" | "medium" | "high";

/** Creates the configured OpenAI-compatible client and fails fast without a key. */
export function createLLMClient(role?: LLMProfileRole, profileId?: string) {
  const { apiKey, apiBaseUrl } = getEffectiveLLMSettings(role, profileId);

  if (!apiKey) {
    throw new Error("LLM API Key 未设置，请在系统设置中配置");
  }

  return new OpenAI({
    apiKey,
    baseURL: apiBaseUrl,
    fetch: (input, init) => llmCacheFetch(input, init, profileId ? `${role ?? "default"}:${profileId}` : role ?? "default"),
  });
}

/** Returns the configured model name without performing a network request. */
export function getLLMModel(role?: LLMProfileRole, profileId?: string): string {
  return getEffectiveLLMSettings(role, profileId).model;
}

/** Shared completion limits for every Student Track LLM caller. */
export function getLLMCompletionOptions(
  role: LLMProfileRole | undefined,
  fallbackMaxTokens: number,
  defaultReasoning = false,
  profileId?: string,
): { max_tokens: number; reasoning_effort?: LLMReasoningEffort } {
  const settings = getEffectiveLLMSettings(role, profileId);
  const reasoningEffort: LLMReasoningEffort | undefined = settings.reasoningEnabled === false && role
    ? "none"
    : (settings.reasoningEnabled ?? defaultReasoning)
      ? settings.reasoningEffort ?? "low"
      : undefined;
  return {
    max_tokens: settings.maxTokens ?? fallbackMaxTokens,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}
