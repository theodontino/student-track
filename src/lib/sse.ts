// v0.13.1: SSE 流式读取工具 — 通用 NDJSON 流解析

export interface SSEEvent {
  type: string;
  [key: string]: any;
}

/**
 * 读取 NDJSON stream（每行一个 JSON），对每条 event 调用 onEvent。
 * 支持 SS E 的 data: 前缀格式和裸 NDJSON 格式。
 */
export async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Strip SSE data: prefix if present
        const json = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
        try {
          const parsed = JSON.parse(json);
          onEvent(parsed);
        } catch { /* skip malformed lines */ }
      }
    }
    // Flush residual
    if (buffer.trim()) {
      try {
        const json = buffer.trim().startsWith("data: ") ? buffer.trim().slice(6) : buffer.trim();
        onEvent(JSON.parse(json));
      } catch { /* skip */ }
    }
  } finally {
    reader.releaseLock();
  }
}
