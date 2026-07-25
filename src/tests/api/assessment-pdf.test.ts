import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  parseAssessmentPdf: vi.fn(),
  sessionFindUnique: vi.fn(),
  studentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    classSession: { findUnique: mocks.sessionFindUnique },
    student: { findMany: mocks.studentFindMany },
  },
}));
vi.mock("@/services/assessment-pdf-service", () => ({
  parseAssessmentPdf: mocks.parseAssessmentPdf,
}));

import { POST } from "@/app/api/feedback/assessment-pdf/route";

function request(fileName = "04示例报告（张三）.pdf") {
  const formData = new FormData();
  formData.set("sessionCode", "TEST-SESSION");
  formData.set("file", new File(["%PDF synthetic"], fileName, { type: "application/pdf" }));
  return new NextRequest("http://127.0.0.1:3000/api/feedback/assessment-pdf", {
    method: "POST",
    body: formData,
  });
}

const evidence = {
  reportTitle: "04示例基础",
  reportDate: "2099-07-13",
  totalQuestions: 5,
  correctRate: 80,
  cohortAverageRate: 72.2,
  knowledgePoints: [],
  wrongItems: [],
  similarPracticeCount: 1,
};

describe("/api/feedback/assessment-pdf", () => {
  beforeEach(() => {
    mocks.sessionFindUnique.mockReset().mockResolvedValue({ classId: "class-1" });
    mocks.studentFindMany.mockReset().mockResolvedValue([
      { id: "student-1", name: "张三", studentId: "TEST-STUDENT-1" },
      { id: "student-2", name: "李四", studentId: "TEST-STUDENT-2" },
    ]);
    mocks.parseAssessmentPdf.mockReset().mockResolvedValue({
      reportStudentName: "张三",
      reportStudentId: "TEST-STUDENT-1",
      evidence,
    });
  });

  it("matches a parsed report to the selected session roster", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matchStatus: "matched",
      matchedStudentId: "student-1",
      evidence: {
        correctRate: 80,
        sessionCode: "TEST-SESSION",
        studentId: "student-1",
      },
    });
    expect(mocks.parseAssessmentPdf).toHaveBeenCalledOnce();
  });

  it("returns a reviewable result when no student can be matched", async () => {
    mocks.parseAssessmentPdf.mockResolvedValue({
      reportStudentName: "王五",
      reportStudentId: "TEST-UNKNOWN",
      evidence,
    });
    const response = await POST(request("unknown.pdf"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matchStatus: "needs_match",
      matchedStudentId: "",
      warning: expect.stringContaining("手动选择"),
    });
  });

  it("blocks conflicting name and student number matches", async () => {
    mocks.parseAssessmentPdf.mockResolvedValue({
      reportStudentName: "张三",
      reportStudentId: "TEST-STUDENT-2",
      evidence,
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("对应不同学生"),
    });
  });
});
