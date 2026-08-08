import OpenAI from "openai";
import { getEffectiveLLMSettings, type LLMProfileRole } from "./llm-settings";
import { llmCacheFetch } from "@/services/llm-cache-service";

export type LLMReasoningEffort = "none" | "low" | "medium" | "high";

function requestBodyWithoutTemperature(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string") return body;
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    if (!("temperature" in payload)) return body;
    const { temperature, ...rest } = payload;
    void temperature;
    return JSON.stringify(rest);
  } catch {
    return body;
  }
}

async function fetchWithModelCompatibility(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  role: string,
) {
  const response = await llmCacheFetch(input, init, role);
  if (![400, 404, 422].includes(response.status) || typeof init?.body !== "string") return response;

  let message = "";
  try {
    const payload = await response.clone().json() as { error?: { message?: unknown } };
    message = typeof payload.error?.message === "string" ? payload.error.message : "";
  } catch {
    return response;
  }
  if (!/temperature/i.test(message)
    || !/(?:invalid|unsupported|not supported|only\s+.+\s+allowed)/i.test(message)) {
    return response;
  }

  const body = requestBodyWithoutTemperature(init.body);
  if (body === init.body) return response;
  return llmCacheFetch(input, { ...init, body }, role);
}

/** Creates the configured OpenAI-compatible client and fails fast without a key. */
export function createLLMClient(role?: LLMProfileRole, profileId?: string) {
  const { apiKey, apiBaseUrl } = getEffectiveLLMSettings(role, profileId);
  const isFeedbackRole = role === "feedbackDraft" || role === "feedbackReview";

  if (!apiKey) {
    throw new Error("LLM API Key 未设置，请在系统设置中配置");
  }

  return new OpenAI({
    apiKey,
    baseURL: apiBaseUrl,
    ...(isFeedbackRole ? { timeout: 180_000, maxRetries: 0 } : {}),
    fetch: (input, init) => fetchWithModelCompatibility(
      input,
      init,
      profileId ? `${role ?? "default"}:${profileId}` : role ?? "default",
    ),
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
