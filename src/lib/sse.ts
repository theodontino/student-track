// Strict SSE/NDJSON reader shared by classroom parsing, feedback and diarize.

export class StreamProtocolError extends Error {
  readonly code = "stream_protocol_error" as const;

  constructor(message = "流式响应格式无效") {
    super(message);
    this.name = "StreamProtocolError";
  }
}

export interface ReadSSEStreamOptions<T> {
  parse: (value: unknown) => T;
  onEvent: (event: T) => void;
  signal?: AbortSignal;
}

function parseLine<T>(line: string, parse: (value: unknown) => T): T | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new StreamProtocolError("流式响应包含无法解析的 JSON");
  }
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof StreamProtocolError) throw error;
    throw new StreamProtocolError("流式响应事件未通过校验");
  }
}

export async function readSSEStream<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  { parse, onEvent, signal }: ReadSSEStreamOptions<T>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let aborted = Boolean(signal?.aborted);
  const abort = () => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (aborted) abort();

  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseLine(line, parse);
        if (event !== null) onEvent(event);
      }
    }
    buffer += decoder.decode();
    if (!aborted && buffer.trim()) {
      const event = parseLine(buffer, parse);
      if (event !== null) onEvent(event);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
