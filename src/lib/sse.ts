// v0.13.1: SSE 流式读取工具 — 通用 NDJSON 流解析

export interface SSEEvent {
  type: string;
  [key: string]: any;
}

/**
 * 读取 NDJSON stream（每行一个 JSON），对每条 event 调用 onEvent。
 * 支持 SSE 的 data: 前缀格式和裸 NDJSON 格式。
 *
 * 异常策略：
 * - JSON parse 失败 → 跳过该行（忽略噪声）
 * - onEvent 内部抛错 → 传播出去，调用方 catch
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
        const json = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
        let parsed: SSEEvent;
        try { parsed = JSON.parse(json); }
        catch { continue; /* skip malformed lines */ }
        onEvent(parsed);
      }
    }
    // Flush residual
    if (buffer.trim()) {
      const json = buffer.trim().startsWith("data: ") ? buffer.trim().slice(6) : buffer.trim();
      let parsed: SSEEvent;
      try { parsed = JSON.parse(json); }
      catch { return; /* skip malformed residual */ }
      onEvent(parsed);
    }
  } finally {
    reader.releaseLock();
  }
}
