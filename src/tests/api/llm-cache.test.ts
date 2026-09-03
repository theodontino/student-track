import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET } from "@/app/api/system/llm-cache/route";
import { llmCacheFetch, withLLMCacheOperation } from "@/services/llm-cache-service";

describe.sequential("/api/system/llm-cache", () => {
  let root = "";
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "llm-cache-api-"));
    vi.stubEnv("LLM_CACHE_ROOT", root);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("returns only operation metadata and clears selected non-active cache", async () => {
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "full");
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "private-model-output" } }],
    }))) as typeof fetch;
    await withLLMCacheOperation("wecom", "企微提取", async () => {
      const response = await llmCacheFetch("http://localhost", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "private-chat-input" }] }),
      });
      await response.text();
    });

    const response = await GET();
    const text = await response.text();
    const payload = JSON.parse(text);
    expect(payload.operations).toHaveLength(1);
    expect(payload.operations[0]).toMatchObject({ taskType: "wecom", callCount: 1, status: "succeeded" });
    expect(text).not.toContain("private-chat-input");
    expect(text).not.toContain("private-model-output");

    const cleared = await DELETE(new NextRequest("http://localhost/api/system/llm-cache?taskType=wecom", {
      method: "DELETE",
    }));
    await expect(cleared.json()).resolves.toEqual({ removed: 1 });
    await expect(GET().then((result) => result.json())).resolves.toMatchObject({ operations: [] });
  });

  it("keeps WeCom cache untouched and unavailable in Core", async () => {
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "full");
    await withLLMCacheOperation("feedback", "生成反馈", async () => undefined);

    const wecomDirectory = path.join(root, "2000-01-01", "wecom", "legacy-wecom-operation");
    const wecomManifestPath = path.join(wecomDirectory, "manifest.json");
    const wecomManifest = JSON.stringify({
      id: "legacy-wecom-operation",
      taskType: "wecom",
      title: "企微提取",
      status: "active",
      startedAt: "2000-01-01T00:00:00.000Z",
      completedAt: null,
      callCount: 0,
      warning: null,
    });
    await mkdir(wecomDirectory, { recursive: true });
    await writeFile(wecomManifestPath, wecomManifest, "utf8");

    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");
    const overviewResponse = await GET();
    const overview = await overviewResponse.json();
    expect(overviewResponse.status).toBe(200);
    expect(overview.operations).toHaveLength(1);
    expect(overview.operations[0]).toMatchObject({ taskType: "feedback", status: "succeeded" });
    await expect(readFile(wecomManifestPath, "utf8")).resolves.toBe(wecomManifest);

    const blocked = await DELETE(new NextRequest("http://localhost/api/system/llm-cache?taskType=wecom", {
      method: "DELETE",
    }));
    expect(blocked.status).toBe(404);
    await expect(blocked.json()).resolves.toEqual({
      error: "当前 Core 版未包含此功能",
      code: "feature_unavailable",
      retryable: false,
    });
    await expect(readFile(wecomManifestPath, "utf8")).resolves.toBe(wecomManifest);

    const cleared = await DELETE(new NextRequest("http://localhost/api/system/llm-cache", {
      method: "DELETE",
    }));
    await expect(cleared.json()).resolves.toEqual({ removed: 1 });
    await expect(GET().then((result) => result.json())).resolves.toMatchObject({ operations: [] });
    await expect(readFile(wecomManifestPath, "utf8")).resolves.toBe(wecomManifest);
  });

  it("rejects unknown task types", async () => {
    const response = await DELETE(new NextRequest("http://localhost/api/system/llm-cache?taskType=unknown", {
      method: "DELETE",
    }));
    expect(response.status).toBe(400);
  });
});
