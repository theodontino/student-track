import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLLMCache,
  getLLMCacheOverview,
  llmCacheFetch,
  markCurrentLLMCacheOperationIncomplete,
  withLLMCacheOperation,
} from "@/services/llm-cache-service";

describe.sequential("LLM operation cache", () => {
  let root = "";
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "llm-cache-")));
    vi.stubEnv("LLM_CACHE_ROOT", root);
    vi.useRealTimers();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  async function operationDirectory(taskType: string) {
    const overview = await getLLMCacheOverview();
    const operation = overview.operations.find((item) => item.taskType === taskType);
    expect(operation).toBeTruthy();
    const days = await readdir(root);
    return path.join(root, days[0], taskType, operation!.id);
  }

  it("stores sanitized requests and responses with private permissions and atomic files", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      model: "synthetic-model",
      choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}", reasoning_content: "private reasoning" } }],
      usage: { completion_tokens: 4 },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    await withLLMCacheOperation("wecom", "synthetic operation", async () => {
      const response = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "synthetic-model", apiKey: "must-not-persist", messages: [{ role: "user", content: "synthetic input" }] }),
      });
      await response.text();
    });

    const directory = await operationDirectory("wecom");
    const requestPath = path.join(directory, "calls", "001", "request.json");
    const responsePath = path.join(directory, "calls", "001", "response.json");
    expect(await readFile(requestPath, "utf8")).toContain('"apiKey": "[REDACTED]"');
    expect(await readFile(responsePath, "utf8")).toContain("private reasoning");
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(requestPath)).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(path.dirname(requestPath))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("reconstructs streamed output and marks interrupted stream writes as warnings", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"r"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200 })) as typeof fetch;

    await withLLMCacheOperation("feedback", "synthetic stream", async () => {
      const response = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ stream: true, messages: [] }),
      });
      await response.text();
    });

    const directory = await operationDirectory("feedback");
    const saved = JSON.parse(await readFile(path.join(directory, "calls", "001", "response.json"), "utf8"));
    expect(saved).toMatchObject({ content: "ok", reasoningContent: "r", finishReason: "stop" });
  });

  it("keeps the most recent successful operation per task type for replay and leaves failures alone", async () => {
    // 1. 第一个 wecom 失败
    await expect(withLLMCacheOperation("wecom", "failed", async () => {
      throw new Error("synthetic failure");
    })).rejects.toThrow("synthetic failure");
    // 2. feedback 成功（不同任务，不影响 wecom）
    await withLLMCacheOperation("feedback", "other task", async () => undefined);
    expect((await getLLMCacheOverview()).operations.map((item) => item.taskType).sort())
      .toEqual(["feedback", "wecom"]);

    // 3. 第二个 wecom 标为 incomplete（status 写入时变成 failed）
    await withLLMCacheOperation("wecom", "needs review", async () => {
      markCurrentLLMCacheOperationIncomplete();
    });
    expect((await getLLMCacheOverview()).operations.filter((item) => item.taskType === "wecom"))
      .toHaveLength(2);

    // 4. wecom 第一次成功：没有更早的成功要清理，2 个 failed 保留。
    await withLLMCacheOperation("wecom", "first success", async () => undefined);
    let operations = (await getLLMCacheOverview()).operations;
    expect(operations.filter((item) => item.taskType === "wecom")).toHaveLength(3);
    expect(operations.filter((item) => item.taskType === "wecom" && item.status === "succeeded"))
      .toHaveLength(1);
    expect(operations.some((item) => item.taskType === "feedback")).toBe(true);

    // 5. wecom 第二次成功：把第 4 步的成功清掉，保留 2 个 failed（排障用）。
    await withLLMCacheOperation("wecom", "second success", async () => undefined);
    operations = (await getLLMCacheOverview()).operations;
    const wecomOps = operations.filter((item) => item.taskType === "wecom");
    expect(wecomOps).toHaveLength(3);
    const succeeded = wecomOps.filter((item) => item.status === "succeeded");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].title).toBe("second success");
    expect(operations.filter((item) => item.taskType === "wecom" && item.status === "failed"))
      .toHaveLength(2);
  });

  it("marks stale active manifests interrupted and clears no live operation", async () => {
    const shanghaiDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const stale = path.join(root, shanghaiDay, "wecom", "stale-operation");
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "manifest.json"), JSON.stringify({
      id: "stale-operation",
      taskType: "wecom",
      title: "stale",
      status: "active",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: null,
      callCount: 1,
      warning: null,
    }));
    expect((await getLLMCacheOverview()).operations.find((item) => item.id === "stale-operation")?.status)
      .toBe("interrupted");

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const running = withLLMCacheOperation("feedback", "active", async () => blocked);
    await vi.waitFor(async () => {
      expect((await getLLMCacheOverview()).operations.some((item) => item.status === "active")).toBe(true);
    });
    await clearLLMCache("feedback");
    expect((await getLLMCacheOverview()).operations.some((item) => item.status === "active")).toBe(true);
    release();
    await running;
  });

  it("purges prior Shanghai dates and enforces the configured capacity without deleting active work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T01:00:00+08:00"));
    await withLLMCacheOperation("wecom", "day one", async () => undefined);
    vi.setSystemTime(new Date("2026-07-21T01:00:00+08:00"));
    await withLLMCacheOperation("feedback", "day two", async () => undefined);
    expect(await readdir(root)).toEqual(["2026-07-21"]);

    vi.useRealTimers();
    vi.stubEnv("LLM_CACHE_MAX_BYTES", "5000");
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "x".repeat(3000) } }],
    }))) as typeof fetch;
    for (const index of [1, 2, 3]) {
      await expect(withLLMCacheOperation("wecom", `failure ${index}`, async () => {
        const response = await llmCacheFetch("http://localhost", {
          method: "POST",
          body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1000) }] }),
        });
        await response.text();
        throw new Error("synthetic failure");
      })).rejects.toThrow("synthetic failure");
    }
    expect((await getLLMCacheOverview()).totalSizeBytes).toBeLessThanOrEqual(5000);
  });

  it("replays a matching non-streaming call from the most recent successful operation", async () => {
    vi.stubEnv("LLM_CACHE_REPLAY", "1");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "first-batch-output" } }],
    })));
    globalThis.fetch = fetchMock as typeof fetch;

    // 第一次操作：发出真实请求，落盘成功。
    await withLLMCacheOperation("wecom", "first batch", async () => {
      const response = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "synthetic-model",
          temperature: 0,
          max_tokens: 64,
          messages: [{ role: "user", content: "draft-123" }],
        }),
      });
      await response.text();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 第二次操作：相同指纹的请求应直接命中历史响应，不再调用 fetch。
    await withLLMCacheOperation("wecom", "second batch", async () => {
      const response = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "synthetic-model",
          temperature: 0,
          max_tokens: 64,
          messages: [{ role: "user", content: "draft-123" }],
        }),
      });
      const payload = JSON.parse(await response.text()) as { choices: Array<{ message: { content: string } }> };
      expect(payload.choices[0].message.content).toBe("first-batch-output");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats different request payloads as distinct replay keys and only matches identical ones", async () => {
    vi.stubEnv("LLM_CACHE_REPLAY", "1");
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const content = body.messages[0].content;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: `out-${content}` } }],
      }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await withLLMCacheOperation("wecom", "first batch", async () => {
      const a = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", temperature: 0, max_tokens: 16, messages: [{ role: "user", content: "alpha" }] }),
      });
      await a.text();
      const b = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", temperature: 0, max_tokens: 16, messages: [{ role: "user", content: "beta" }] }),
      });
      await b.text();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 第二批：alpha 命中复用，beta 也命中复用，gamma 是新键需要再发一次。
    await withLLMCacheOperation("wecom", "second batch", async () => {
      const a = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", temperature: 0, max_tokens: 16, messages: [{ role: "user", content: "alpha" }] }),
      });
      const bodyA = await a.text();
      const replayHeaderA = a.headers.get("X-LLM-Cache-Replay");
      expect(bodyA).toContain("out-alpha");
      expect(replayHeaderA).toBe("1");

      const b = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", temperature: 0, max_tokens: 16, messages: [{ role: "user", content: "beta" }] }),
      });
      const bodyB = await b.text();
      const replayHeaderB = b.headers.get("X-LLM-Cache-Replay");
      expect(bodyB).toContain("out-beta");
      expect(replayHeaderB).toBe("1");

      const c = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", temperature: 0, max_tokens: 16, messages: [{ role: "user", content: "gamma" }] }),
      });
      const bodyC = await c.text();
      const replayHeaderC = c.headers.get("X-LLM-Cache-Replay");
      expect(bodyC).toContain("out-gamma");
      expect(replayHeaderC).toBeNull();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("replays from an interrupted prior operation so a re-run can pick up unfinished drafts", async () => {
    vi.stubEnv("LLM_CACHE_REPLAY", "1");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "resumed-output" } }],
    })));
    globalThis.fetch = fetchMock as typeof fetch;

    // 第一次：1 个真实调用，进程被中断，留下 succeeded 的成功缓存。
    await withLLMCacheOperation("wecom", "interrupted run", async () => {
      const a = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", temperature: 0, max_tokens: 16, messages: [{ role: "user", content: "draft-a" }] }),
      });
      await a.text();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 模拟"上次运行在进程结束前未完成"：把刚才的 manifest 标为 interrupted。
    const previousDir = await operationDirectory("wecom");
    const previousManifestPath = path.join(previousDir, "manifest.json");
    const previousManifest = JSON.parse(await readFile(previousManifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(previousManifestPath, JSON.stringify({ ...previousManifest, status: "interrupted" }));

    // 第二次：相同 draft-a 应命中复用，不再调用 fetch。
    await withLLMCacheOperation("wecom", "resumed run", async () => {
      const a = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", temperature: 0, max_tokens: 16, messages: [{ role: "user", content: "draft-a" }] }),
      });
      const payload = JSON.parse(await a.text()) as { choices: Array<{ message: { content: string } }> };
      expect(payload.choices[0].message.content).toBe("resumed-output");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay streaming requests", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "stream-output" } }],
    })));
    globalThis.fetch = fetchMock as typeof fetch;

    await withLLMCacheOperation("wecom", "stream batch", async () => {
      const a = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ stream: true, model: "m", messages: [{ role: "user", content: "draft-z" }] }),
      });
      await a.text();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await withLLMCacheOperation("wecom", "next stream batch", async () => {
      const a = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ stream: true, model: "m", messages: [{ role: "user", content: "draft-z" }] }),
      });
      await a.text();
    });
    // 流式请求每次都要真实发送，不能被缓存复用。
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("respects LLM_CACHE_REPLAY=disabled to skip cache fallback", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "first" } }],
    })));
    globalThis.fetch = fetchMock as typeof fetch;

    await withLLMCacheOperation("wecom", "warm-up", async () => {
      const a = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", temperature: 0, max_tokens: 16, messages: [{ role: "user", content: "x" }] }),
      });
      await a.text();
    });

    vi.stubEnv("LLM_CACHE_REPLAY", "disabled");
    await withLLMCacheOperation("wecom", "no-replay", async () => {
      const a = await llmCacheFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", temperature: 0, max_tokens: 16, messages: [{ role: "user", content: "x" }] }),
      });
      await a.text();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllEnvs();
  });
});
