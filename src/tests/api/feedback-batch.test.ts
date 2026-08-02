import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/report/feedback-batch/route";

const sessionCode = "VITEST-FEEDBACK";
const classCode = "VITEST-FEEDBACK-CLASS";
const studentNumber = "VITEST-FEEDBACK-STUDENT";
const semesterName = "VITEST-FEEDBACK-SEMESTER";

afterEach(async () => {
  await prisma.workHistory.deleteMany({ where: { module: "feedback", key: sessionCode } });
  await prisma.student.deleteMany({ where: { studentId: studentNumber } });
  await prisma.generationRecord.deleteMany({
    where: { sourceFingerprint: "feedback-export-selected" },
  });
  await prisma.classSession.deleteMany({ where: { code: sessionCode } });
  await prisma.semester.deleteMany({ where: { name: semesterName } });
  await prisma.class.deleteMany({ where: { code: classCode } });
});

describe("/api/report/feedback-batch", () => {
  it("rebuilds an Excel download from long-term history", async () => {
    const classRecord = await prisma.class.create({ data: { code: classCode, name: "测试班" } });
    const semester = await prisma.semester.create({
      data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" },
    });
    const student = await prisma.student.create({
      data: { name: "张三", studentId: studentNumber, gender: "男", classId: classRecord.id },
    });
    const session = await prisma.classSession.create({
      data: {
        code: sessionCode,
        semesterId: semester.id,
        semesterNumber: 1,
        date: "2099-01-01",
        classId: classRecord.id,
      },
    });
    await prisma.sessionMetric.create({
      data: {
        studentId: student.id,
        sessionId: session.id,
        date: session.date,
        scoreA: 4,
        scoreB: 5,
        scoreC: 3,
        scoreD: 5,
        operator: "teacher",
      },
    });
    const teacherEditedFeedback = "教师修改后的反馈文本。";
    const modelOriginalFeedback = "模型生成的原始反馈文本。";
    await prisma.workHistory.create({
      data: {
        module: "feedback",
        key: sessionCode,
        title: "blocked feedback test",
        state: JSON.stringify({
          kind: "batch",
          semesterId: semester.id,
          sessionCode,
          className: "测试班",
          total: 1,
          students: [{ id: student.id, name: "张三", labels: [], feedback: "待复核反馈。", reviewStatus: "needs_review" }],
        }),
      },
    });

    const blockedResponse = await GET(new NextRequest(`http://localhost:3000/api/report/feedback-batch?sessionCode=${sessionCode}&module=feedback`));
    expect(blockedResponse.status).toBe(409);
    await expect(blockedResponse.json()).resolves.toMatchObject({ error: expect.stringContaining("1 条反馈需要人工确认") });

    await prisma.workHistory.create({
      data: {
        module: "feedback",
        key: sessionCode,
        title: "legacy length-only review",
        state: JSON.stringify({
          kind: "batch",
          semesterId: semester.id,
          sessionCode,
          className: "测试班",
          total: 1,
          students: [{
            id: student.id,
            name: "张三",
            labels: [],
            feedback: "短反馈。",
            reviewStatus: "needs_review",
            reviewIssues: ["反馈长度为 4 个可见字符，应为 90–140 个"],
          }],
        }),
      },
    });
    const lengthOnlyResponse = await GET(new NextRequest(`http://localhost:3000/api/report/feedback-batch?sessionCode=${sessionCode}&module=feedback`));
    expect(lengthOnlyResponse.status).toBe(200);
    expect((await lengthOnlyResponse.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    await prisma.workHistory.create({
      data: {
        module: "feedback",
        key: sessionCode,
        title: "feedback test",
        state: JSON.stringify({
          kind: "batch",
          semesterId: semester.id,
          sessionCode,
          className: "测试班",
          total: 1,
          inputRevision: "feedback-export-revision",
          outputStrategy: {
            flaggedIssue: true,
            trendChange: false,
            backgroundBaseline: false,
            strategySuggestion: false,
            suggestedFeedback: true,
            style: "balanced",
            length: "standard",
          },
          students: [{ id: student.id, name: "张三", labels: [], feedback: teacherEditedFeedback, reviewStatus: "edited" }],
        }),
      },
    });
    const selectedGeneration = await prisma.generationRecord.create({
      data: {
        taskType: "feedback",
        stage: "routine",
        sessionId: session.id,
        studentId: student.id,
        sourceRefs: "[]",
        sourceFingerprint: "feedback-export-selected",
        promptVersion: "feedback-composable-v2",
        modelName: "synthetic",
        modelSettings: "{}",
        inputRevision: "feedback-export-revision",
        outputSnapshot: JSON.stringify({
          reviewStatus: "needs_review",
          reviewIssues: ["模型原文曾经越界"],
          modelRawFinalText: "短",
        }),
        finalText: modelOriginalFeedback,
      },
    });
    await prisma.feedbackGenerationSelection.create({
      data: {
        sessionId: session.id,
        studentId: student.id,
        selectedGenerationId: selectedGeneration.id,
      },
    });

    const response = await GET(new NextRequest(`http://localhost:3000/api/report/feedback-batch?sessionCode=${sessionCode}&module=feedback`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("spreadsheetml");
    const body = await response.arrayBuffer();
    expect(response.headers.get("content-length")).toBe(String(body.byteLength));
    expect(body.byteLength).toBeGreaterThan(1000);
    const workbook = XLSX.read(body, { type: "array" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["课后反馈"]!, {
      defval: "",
    });
    expect(rows[0]).toMatchObject({ 姓名: "张三", 最终反馈: teacherEditedFeedback });
    expect(rows[0]?.最终反馈).not.toBe(modelOriginalFeedback);
    await expect(prisma.generationRecord.findUniqueOrThrow({
      where: { id: selectedGeneration.id },
    })).resolves.toMatchObject({ finalText: teacherEditedFeedback });
  });
});
