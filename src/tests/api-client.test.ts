import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, requestJson, requestJsonValidated } from "@/lib/api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestJsonValidated", () => {
  const responseSchema = z.object({ id: z.string().min(1), count: z.number().int() });

  it("returns a response only after runtime validation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "student-1", count: 2 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    await expect(requestJsonValidated(responseSchema, "/api/example")).resolves.toEqual({
      id: "student-1",
      count: 2,
    });
  });

  it("rejects a successful HTTP response with an invalid body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "", count: "2" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    await expect(requestJsonValidated(responseSchema, "/api/example")).rejects.toBeInstanceOf(z.ZodError);
  });

  it("preserves a valid public error envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "服务暂时不可用",
      code: "llm_service_error",
      retryable: true,
      diagnosticId: "diag-test",
    }), { status: 502, headers: { "Content-Type": "application/json" } })));

    await expect(requestJson("/api/example")).rejects.toEqual(expect.objectContaining<ApiError>({
      name: "ApiError",
      status: 502,
      message: "服务暂时不可用",
      code: "llm_service_error",
      retryable: true,
      diagnosticId: "diag-test",
    }));
  });

  it("safely normalizes legacy and unknown error responses", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "旧接口错误" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "未来错误",
        code: "future_error",
        retryable: true,
      }), { status: 409, headers: { "Content-Type": "application/json" } })));

    await expect(requestJson("/api/legacy")).rejects.toEqual(expect.objectContaining<ApiError>({
      name: "ApiError",
      status: 400,
      code: "internal_error",
      retryable: false,
      message: "旧接口错误",
    }));
    await expect(requestJson("/api/future")).rejects.toEqual(expect.objectContaining<ApiError>({
      name: "ApiError",
      status: 409,
      code: "internal_error",
      retryable: false,
      message: "未来错误",
    }));
  });
});
