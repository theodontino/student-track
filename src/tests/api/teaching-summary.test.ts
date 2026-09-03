import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  getTeachingSummary: vi.fn(),
  generateTeachingSummary: vi.fn(),
  listTeacherObservations: vi.fn(),
  updateTeacherObservationStatus: vi.fn(),
}));

vi.mock("@/services/teaching-summary-service", () => ({
  getTeachingSummary: mocks.getTeachingSummary,
  generateTeachingSummary: mocks.generateTeachingSummary,
}));
vi.mock("@/services/teacher-observation-service", () => ({
  listTeacherObservations: mocks.listTeacherObservations,
  updateTeacherObservationStatus: mocks.updateTeacherObservationStatus,
}));

import { GET, POST } from "@/app/api/report/teaching-summary/route";
import { POST as legacyPOST } from "@/app/api/report/daily/route";
import { GET as observationsGET } from "@/app/api/teacher-observations/route";
import { PATCH as observationPATCH } from "@/app/api/teacher-observations/[id]/route";

const bundle = {
  facts: {
    date: "2026-07-01",
    totals: { coveredStudentCount: 2, metricRecordedCount: 2, attendanceRecordedCount: 2 },
    sessions: [{ className: "测试班" }],
  },
  analysis: { overview: "教师内部总结" },
  observations: [],
  cache: { status: "hit", generatedAt: "2026-07-01T00:00:00.000Z" },
};

describe("teaching summary APIs", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getTeachingSummary.mockResolvedValue(bundle);
    mocks.generateTeachingSummary.mockResolvedValue(bundle);
    mocks.listTeacherObservations.mockResolvedValue([]);
  });

  it("parses session/date queries and preserves the legacy daily response", async () => {
    const response = await GET(new NextRequest("http://localhost/api/report/teaching-summary?scope=session&sessionCode=S1&includeCommunications=0"));
    expect(response.status).toBe(200);
    expect(mocks.getTeachingSummary).toHaveBeenCalledWith(expect.objectContaining({
      scope: { type: "session", sessionCode: "S1" },
      includeCommunications: false,
    }));

    const legacy = await legacyPOST(new NextRequest("http://localhost/api/report/daily", {
      method: "POST",
      body: JSON.stringify({ sessionCode: "S1" }),
    }));
    await expect(legacy.json()).resolves.toMatchObject({
      report: "教师内部总结",
      className: "测试班",
      studentCount: 2,
    });
  });

  it("returns a safe validation error for invalid model references", async () => {
    mocks.generateTeachingSummary.mockRejectedValue(new Error("llm_reference_invalid"));
    const response = await POST(new NextRequest("http://localhost/api/report/teaching-summary", {
      method: "POST",
      body: JSON.stringify({
        scope: { type: "session", sessionCode: "S1" },
        includeCommunications: true,
      }),
    }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "llm_schema_invalid",
      retryable: true,
    });
  });

  it("validates observation filters and status updates", async () => {
    const invalid = await observationsGET(new NextRequest("http://localhost/api/teacher-observations?status=unknown"));
    expect(invalid.status).toBe(400);

    mocks.updateTeacherObservationStatus.mockResolvedValue({ id: "O1", status: "handled" });
    const updated = await observationPATCH(new NextRequest("http://localhost/api/teacher-observations/O1", {
      method: "PATCH",
      body: JSON.stringify({ status: "handled" }),
    }), { params: Promise.resolve({ id: "O1" }) });
    expect(updated.status).toBe(200);
    expect(mocks.updateTeacherObservationStatus).toHaveBeenCalledWith("O1", "handled");
  });

  it("preserves recycle-bin API errors for observation reads and writes", async () => {
    mocks.listTeacherObservations.mockRejectedValueOnce(
      new ApiError("班级或所属学期位于回收站，当前不可用", 409, "scope_in_recycle_bin", false),
    );
    const listed = await observationsGET(new NextRequest("http://localhost/api/teacher-observations?classId=C1"));
    expect(listed.status).toBe(409);
    await expect(listed.json()).resolves.toMatchObject({ code: "scope_in_recycle_bin", retryable: false });

    mocks.updateTeacherObservationStatus.mockRejectedValueOnce(
      new ApiError("观察所属范围位于回收站，当前不可用", 409, "scope_in_recycle_bin", false),
    );
    const updated = await observationPATCH(new NextRequest("http://localhost/api/teacher-observations/O1", {
      method: "PATCH",
      body: JSON.stringify({ status: "handled" }),
    }), { params: Promise.resolve({ id: "O1" }) });
    expect(updated.status).toBe(409);
    await expect(updated.json()).resolves.toMatchObject({ code: "scope_in_recycle_bin", retryable: false });
  });
});
