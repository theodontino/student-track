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
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(requestPath)).mode & 0o777).toBe(0o600);
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

  it("retains failures until the next successful operation of the same task only", async () => {
    await expect(withLLMCacheOperation("wecom", "failed", async () => {
      throw new Error("synthetic failure");
    })).rejects.toThrow("synthetic failure");
    await withLLMCacheOperation("feedback", "other task", async () => undefined);
    expect((await getLLMCacheOverview()).operations.map((item) => item.taskType).sort())
      .toEqual(["feedback", "wecom"]);

    await withLLMCacheOperation("wecom", "needs review", async () => {
      markCurrentLLMCacheOperationIncomplete();
    });
    expect((await getLLMCacheOverview()).operations.filter((item) => item.taskType === "wecom"))
      .toHaveLength(2);

    await withLLMCacheOperation("wecom", "successful retry", async () => undefined);
    const operations = (await getLLMCacheOverview()).operations;
    expect(operations.filter((item) => item.taskType === "wecom")).toHaveLength(1);
    expect(operations.some((item) => item.taskType === "feedback")).toBe(true);
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
});
