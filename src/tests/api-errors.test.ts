import { describe, expect, it } from "vitest";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { ApiErrorResponseSchema } from "@/lib/contracts/api";

describe("public API error envelope", () => {
  it("always includes a stable code and retryable flag", () => {
    const body = apiErrorBody(new ApiError("请求失败", 400));
    expect(body).toEqual({
      error: "请求失败",
      code: "internal_error",
      retryable: false,
    });
    expect(ApiErrorResponseSchema.parse(body)).toEqual(body);
  });

  it("adds a diagnostic id for server errors without exposing details", () => {
    const error = new ApiError("服务失败", 500, "internal_error", false, { secret: "hidden" });
    const body = apiErrorBody(error);
    expect(body.diagnosticId).toEqual(expect.any(String));
    expect(body.diagnosticId).not.toHaveLength(0);
    expect(body).not.toHaveProperty("details");
    expect(ApiErrorResponseSchema.parse(body)).toEqual(body);
  });
});
