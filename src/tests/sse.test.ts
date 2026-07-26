import { describe, expect, it } from "vitest";
import { readSSEStream, StreamProtocolError } from "@/lib/sse";
import { ApiError, apiStreamErrorBody } from "@/lib/api-errors";
import { ParseStreamEventSchema } from "@/lib/contracts/classroom-parse";

function streamOf(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

describe("readSSEStream", () => {
  const parse = (value: unknown) => {
    if (!value || typeof value !== "object" || !("type" in value)) throw new Error("invalid event");
    return value as { type: string };
  };

  it("supports SSE prefixes, comments, CRLF, NDJSON and split chunks", async () => {
    const events: string[] = [];
    await readSSEStream(streamOf([": keep-alive\r\ndata: {\"type\":\"one\"}\r\n", "data:{\"type\":\"two\"}\n{\"type\":\"three\"}"]).getReader(), {
      parse,
      onEvent: (event) => events.push(event.type),
    });
    expect(events).toEqual(["one", "two", "three"]);
  });

  it("keeps streamed API errors compatible with the shared event contract", () => {
    expect(ParseStreamEventSchema.parse({
      type: "error",
      ...apiStreamErrorBody(new ApiError("模型暂时不可用", 502, "llm_service_error", true)),
    })).toMatchObject({
      type: "error",
      message: "模型暂时不可用",
      code: "llm_service_error",
      retryable: true,
    });
  });

  it("validates a residual event and propagates callback errors", async () => {
    await expect(readSSEStream(streamOf(["{\"type\":\"error\"}"]).getReader(), {
      parse,
      onEvent: (event) => { throw new Error(`${event.type} callback failure`); },
    })).rejects.toThrow("callback failure");
  });

  it("rejects malformed JSON instead of silently dropping it", async () => {
    await expect(readSSEStream(streamOf(["{not-json}\n"]).getReader(), { parse, onEvent: () => undefined }))
      .rejects.toBeInstanceOf(StreamProtocolError);
  });

  it("cancels the reader on abort and releases the lock", async () => {
    let cancelled = false;
    let resolveRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    const reader = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { resolveRead = resolve; }),
      cancel: async () => { cancelled = true; resolveRead?.({ done: true, value: undefined }); },
      releaseLock: () => undefined,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const controller = new AbortController();
    const reading = readSSEStream(reader, { parse, onEvent: () => undefined, signal: controller.signal });
    controller.abort();
    await reading;
    expect(cancelled).toBe(true);
  });

  it("cancels immediately when the supplied signal is already aborted", async () => {
    let cancelled = false;
    const reader = {
      read: () => Promise.resolve({ done: true, value: undefined }),
      cancel: async () => { cancelled = true; },
      releaseLock: () => undefined,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const controller = new AbortController();
    controller.abort();

    await readSSEStream(reader, { parse, onEvent: () => undefined, signal: controller.signal });

    expect(cancelled).toBe(true);
  });
});
