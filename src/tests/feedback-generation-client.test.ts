import { afterEach, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { capacityControlledFeedbackClient, feedbackProviderKey } from "@/services/feedback-plan/generation-client";
import { feedbackRequestCapacity } from "@/services/feedback-plan/generation-capacity";

afterEach(() => feedbackRequestCapacity.reset());
it("shares capacity for one endpoint and credential while keeping credentials out of status", async () => {
  const identity = { baseURL: "https://MODEL.example/v1/", apiKey: "synthetic-key" };
  expect(feedbackProviderKey(identity)).toBe(feedbackProviderKey({ ...identity, baseURL: "https://model.example/v1" }));
  expect(feedbackProviderKey(identity)).not.toBe(feedbackProviderKey({ ...identity, apiKey: "another-synthetic-key" }));
  let release!: () => void;
  const first = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const second = vi.fn(async () => ({ choices: [] }));
  const client = (create: unknown) => capacityControlledFeedbackClient({ ...identity, chat: { completions: { create } } } as OpenAI);
  const body = { model: "synthetic", messages: [] };
  const one = client(first).chat.completions.create(body);
  const two = client(second).chat.completions.create(body);
  await Promise.resolve();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  expect(JSON.stringify(feedbackRequestCapacity.snapshot())).not.toContain(identity.apiKey);
  release();
  await Promise.all([one, two]);
  expect(second).toHaveBeenCalledWith(body, { signal: undefined });
});
