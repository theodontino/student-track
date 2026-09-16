import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeedbackIntakeRun: vi.fn(),
  recordDiagnosticFailure: vi.fn(),
  resolveFeedbackIntakeRun: vi.fn(),
  setGroupLessonCommonMaterial: vi.fn(),
  setSessionCommonMaterial: vi.fn(),
}));

vi.mock("@/lib/diagnostics", () => ({
  recordDiagnosticFailure: mocks.recordDiagnosticFailure,
}));

vi.mock("@/services/common-material-service", () => ({
  setGroupLessonCommonMaterial: mocks.setGroupLessonCommonMaterial,
  setSessionCommonMaterial: mocks.setSessionCommonMaterial,
}));

vi.mock("@/services/feedback-intake-service", () => ({
  getFeedbackIntakeRun: mocks.getFeedbackIntakeRun,
  resolveFeedbackIntakeRun: mocks.resolveFeedbackIntakeRun,
}));

import { POST as resolveIntakeRun } from "@/app/api/feedback/intake/runs/[id]/route";
import { PUT as saveGroupLessonMaterial } from "@/app/api/group-lessons/[id]/common-material/route";
import { PUT as saveSessionMaterial } from "@/app/api/sessions/[id]/common-material/route";
import { ApiError } from "@/lib/api-errors";
import { ServiceError } from "@/services/service-error";

function request(path: string, body: unknown, method = "PUT") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: "test-target" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordDiagnosticFailure.mockResolvedValue(undefined);
});

describe("route 5xx error safety", () => {
  it("preserves explicit 4xx errors", async () => {
    mocks.setGroupLessonCommonMaterial.mockRejectedValueOnce(new ServiceError("共同课不存在", 404));
    const groupResponse = await saveGroupLessonMaterial(
      request("/api/group-lessons/test-target/common-material", { lessonNumber: 1 }),
      context,
    );
    expect(groupResponse.status).toBe(404);
    await expect(groupResponse.json()).resolves.toEqual({ error: "共同课不存在" });

    mocks.setSessionCommonMaterial.mockRejectedValueOnce(new ServiceError("当前课次已关联共同课", 409));
    const sessionResponse = await saveSessionMaterial(
      request("/api/sessions/test-target/common-material", { lessonNumber: 1 }),
      context,
    );
    expect(sessionResponse.status).toBe(409);
    await expect(sessionResponse.json()).resolves.toEqual({ error: "当前课次已关联共同课" });

    mocks.resolveFeedbackIntakeRun.mockRejectedValueOnce(
      new ApiError("反馈范围已进入回收站", 409, "scope_in_recycle_bin", false),
    );
    const intakeResponse = await resolveIntakeRun(
      request("/api/feedback/intake/runs/test-target", { action: "confirm" }, "POST"),
      context,
    );
    expect(intakeResponse.status).toBe(409);
    await expect(intakeResponse.json()).resolves.toMatchObject({
      error: "反馈范围已进入回收站",
      code: "scope_in_recycle_bin",
      retryable: false,
    });
    expect(mocks.recordDiagnosticFailure).not.toHaveBeenCalled();
  });

  it("sanitizes ordinary server failures and records a diagnostic id", async () => {
    mocks.setGroupLessonCommonMaterial.mockRejectedValueOnce(new ServiceError("raw group service failure", 503));
    const groupResponse = await saveGroupLessonMaterial(
      request("/api/group-lessons/test-target/common-material", { lessonNumber: 1 }),
      context,
    );
    expect(groupResponse.status).toBe(500);
    const groupBody = await groupResponse.json();
    expect(groupBody).toMatchObject({
      error: "保存共同课公共材料失败",
      code: "internal_error",
      retryable: false,
      diagnosticId: expect.any(String),
    });
    expect(JSON.stringify(groupBody)).not.toContain("raw group service failure");

    mocks.setSessionCommonMaterial.mockRejectedValueOnce(new Error("raw session database failure"));
    const sessionResponse = await saveSessionMaterial(
      request("/api/sessions/test-target/common-material", { lessonNumber: 1 }),
      context,
    );
    expect(sessionResponse.status).toBe(500);
    const sessionBody = await sessionResponse.json();
    expect(sessionBody).toMatchObject({
      error: "保存课次公共材料失败",
      code: "internal_error",
      retryable: false,
      diagnosticId: expect.any(String),
    });
    expect(JSON.stringify(sessionBody)).not.toContain("raw session database failure");

    mocks.resolveFeedbackIntakeRun.mockRejectedValueOnce(new Error("raw intake database failure"));
    const intakeResponse = await resolveIntakeRun(
      request("/api/feedback/intake/runs/test-target", { action: "confirm" }, "POST"),
      context,
    );
    expect(intakeResponse.status).toBe(500);
    const intakeBody = await intakeResponse.json();
    expect(intakeBody).toMatchObject({
      error: "处理反馈材料运行失败",
      code: "internal_error",
      retryable: false,
      diagnosticId: expect.any(String),
    });
    expect(JSON.stringify(intakeBody)).not.toContain("raw intake database failure");

    expect(mocks.recordDiagnosticFailure).toHaveBeenCalledTimes(3);
    expect(mocks.recordDiagnosticFailure).toHaveBeenCalledWith(expect.objectContaining({
      source: "api.safe_error",
      status: 500,
      code: "internal_error",
      retryable: false,
    }));
  });
});
