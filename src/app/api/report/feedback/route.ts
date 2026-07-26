import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import {
  isLessonFeedbackMaterial,
  isStudentAssessmentEvidence,
} from "@/lib/feedback-materials";
import { buildFeedbackContext } from "@/services/feedback-context-service";
import {
  composeFeedbackPromptContext,
  generateReviewedFeedback,
} from "@/services/feedback-generation-service";
import {
  markCurrentLLMCacheOperationIncomplete,
  withLLMCacheOperation,
} from "@/services/llm-cache-service";
import { apiErrorBody, ApiError } from "@/lib/api-errors";

async function reviewedFeedback(
  studentName: string,
  promptContext: string,
  lengthRequirement: string,
  forbiddenStudentNames: string[] = [],
  signal?: AbortSignal,
) {
  return generateReviewedFeedback({
    studentName,
    promptContext,
    forbiddenStudentNames,
    lengthRequirement,
    draftClient: createLLMClient("feedbackDraft"),
    draftModel: getLLMModel("feedbackDraft"),
    reviewClient: createLLMClient("feedbackReview"),
    reviewModel: getLLMModel("feedbackReview"),
    signal,
  });
}

// POST /api/report/feedback - 按课次或时间段生成家校反馈
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const studentId = typeof body.studentId === "string" ? body.studentId : "";
    const sessionCode = typeof body.sessionCode === "string" ? body.sessionCode : "";
    const days = typeof body.days === "number" ? body.days : undefined;
    const submittedLessonMaterial = body.lessonMaterial === undefined ? undefined : isLessonFeedbackMaterial(body.lessonMaterial) ? body.lessonMaterial : null;
    const submittedAssessmentEvidence = body.assessmentEvidence === undefined ? undefined : isStudentAssessmentEvidence(body.assessmentEvidence) ? body.assessmentEvidence : null;
    if (submittedLessonMaterial === null || submittedAssessmentEvidence === null) {
      return NextResponse.json({ error: "反馈材料格式无效", code: "invalid_request", retryable: false }, { status: 400 });
    }
    if (!studentId) return NextResponse.json({ error: "缺少学生ID" }, { status: 400 });

    if (sessionCode) {
      if (submittedLessonMaterial?.sessionCode && submittedLessonMaterial.sessionCode !== sessionCode) {
        return NextResponse.json({ error: "课程材料与当前课次不一致" }, { status: 400 });
      }
      if (submittedAssessmentEvidence?.sessionCode && submittedAssessmentEvidence.sessionCode !== sessionCode) {
        return NextResponse.json({ error: "PDF 证据与当前课次不一致" }, { status: 400 });
      }
      if (submittedAssessmentEvidence?.studentId && submittedAssessmentEvidence.studentId !== studentId) {
        return NextResponse.json({ error: "PDF 证据与当前学生不一致" }, { status: 400 });
      }
      const lessonMaterial = submittedLessonMaterial
        ? { ...submittedLessonMaterial, sessionCode }
        : undefined;
      const assessmentEvidence = submittedAssessmentEvidence
        ? { ...submittedAssessmentEvidence, sessionCode, studentId }
        : undefined;
      try {
        const feedbackContext = await buildFeedbackContext(prisma, sessionCode);
        const studentContext = feedbackContext.students.find((student) => student.id === studentId);
        if (!studentContext) return NextResponse.json({ error: "该学生不属于当前课次班级" }, { status: 404 });

        return NextResponse.json(await withLLMCacheOperation(
          "feedback",
          "生成单人课次反馈",
          async () => {
            const result = await reviewedFeedback(
              studentContext.name,
              composeFeedbackPromptContext({
                studentContext: studentContext.promptContext,
                sessionCode,
                studentId,
                lessonMaterial,
                assessmentEvidence,
              }),
              "120-170字",
              feedbackContext.students.filter((student) => student.id !== studentId).map((student) => student.name),
              process.env.NODE_ENV === "test" ? undefined : request.signal,
            );
            if (result.reviewStatus === "needs_review") markCurrentLLMCacheOperationIncomplete();
            return result;
          },
        ));
      } catch (error) {
        const apiError = error instanceof ApiError ? error : new ApiError("生成反馈失败，请稍后重试", 500, "internal_error", false);
        return NextResponse.json(apiErrorBody(apiError), { status: apiError.status });
      }
    }

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: { class: { select: { name: true, code: true } } },
    });
    if (!student) return NextResponse.json({ error: "学生不存在" }, { status: 404 });

    const d = days || 14;
    const since = new Date(); since.setDate(since.getDate() - d);
    const sinceStr = since.toISOString().split("T")[0];

    const [metrics, events, comms, attendances] = await Promise.all([
      prisma.sessionMetric.findMany({ where: { studentId, date: { gte: sinceStr } }, orderBy: { date: "desc" } }),
      prisma.event.findMany({ where: { studentId, session: { date: { gte: sinceStr } } }, orderBy: { createdAt: "desc" }, include: { session: { select: { date: true } } } }),
      prisma.communication.findMany({ where: { studentId, session: { date: { gte: sinceStr } } }, orderBy: { createdAt: "desc" }, include: { session: { select: { date: true } } } }),
      prisma.attendance.findMany({ where: { studentId, session: { date: { gte: sinceStr } } }, include: { session: { select: { date: true } } } }),
    ]);

    const avgA = metrics.length ? (metrics.reduce((sum, metric) => sum + metric.scoreA, 0) / metrics.length).toFixed(1) : "-";
    const avgB = metrics.length ? (metrics.reduce((sum, metric) => sum + metric.scoreB, 0) / metrics.length).toFixed(1) : "-";
    const avgC = metrics.length ? (metrics.reduce((sum, metric) => sum + metric.scoreC, 0) / metrics.length).toFixed(1) : "-";
    const total = attendances.length;
    const present = attendances.filter((attendance) => attendance.present).length;
    const context = `${student.name}（${student.class?.name ?? student.class?.code ?? ""}）近${d}天表现：
- 学习(A): 均分${avgA} | 纪律(B): 均分${avgB} | 作业(C): 均分${avgC}
- 考勤: ${total ? `${present}/${total}` : "无记录"}
- 关键事件: ${events.map((event) => event.description).join("；") || "无"}
- 家校沟通: ${comms.map((communication) => `${communication.session?.date ?? "-"}与${communication.target}:${communication.summary}`).join("；") || "无"}`;

    return NextResponse.json(await withLLMCacheOperation(
      "feedback",
      "生成单人近期反馈",
      async () => {
        const result = await reviewedFeedback(student.name, context, "120-180字", [], process.env.NODE_ENV === "test" ? undefined : request.signal);
        if (result.reviewStatus === "needs_review") markCurrentLLMCacheOperationIncomplete();
        return result;
      },
    ));
  } catch (error) {
    console.error("[/api/report/feedback] error:", error instanceof Error ? error.message : "unknown");
    const apiError = new ApiError("生成反馈失败，请稍后重试", 500, "internal_error", false);
    return NextResponse.json(apiErrorBody(apiError), { status: apiError.status });
  }
}
