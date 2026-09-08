import { createHash } from "node:crypto";
import type OpenAI from "openai";
import { feedbackRequestCapacity } from "./generation-capacity";

/** Private identity: credentials never enter the public capacity view. */
export function feedbackProviderKey(client: Pick<OpenAI, "baseURL" | "apiKey">) {
  const url = new URL(client.baseURL);
  url.hash = "";
  const endpoint = url.toString().replace(/\/+$/, "");
  return createHash("sha256").update(endpoint).update("\0").update(client.apiKey ?? "").digest("hex");
}

/** Queue outside the SDK so its timeout measures HTTP time, not capacity waiting. */
export function capacityControlledFeedbackClient(client: OpenAI, signal?: AbortSignal) {
  const key = feedbackProviderKey(client);
  const create = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = ((...args: Parameters<typeof create>) => {
    const [body, options] = args;
    const requestSignal = options?.signal ?? signal;
    return feedbackRequestCapacity.run(key, async () => create(body, { ...options, signal: requestSignal }), requestSignal ?? undefined);
  }) as typeof client.chat.completions.create;
  return client;
}
