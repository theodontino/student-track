import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import {
  isLessonFeedbackMaterial,
  isStudentAssessmentEvidence,
} from "@/lib/feedback-materials";
import { buildFeedbackContext } from "@/services/feedback-context-service";
import { buildFeedbackRouting } from "@/services/feedback-intensity-service";
import {
  composeFeedbackPromptContext,
  generateReviewedFeedback,
  generateRoutineFeedback,
  summarizeLessonMaterial,
} from "@/services/feedback-generation-service";
import { FEEDBACK_INTENSITIES, type FeedbackIntensity } from "@/lib/feedback-intensity";
import {
  normalizeFeedbackOutputStrategy,
  type FeedbackLength,
  type FeedbackOutputStrategy,
  type FeedbackStyle,
} from "@/lib/feedback-sections";
import { FeedbackOutputStrategySchema } from "@/lib/contracts/feedback";
import { buildFeedbackSections } from "@/services/feedback-sections-service";
import {
  markCurrentLLMCacheOperationIncomplete,
  withLLMCacheOperation,
} from "@/services/llm-cache-service";
import { compactHotGenerationRecordsForClass, recordSuccessfulGeneration } from "@/services/generation-memory-service";
import { apiErrorBody, ApiError } from "@/lib/api-errors";
import { getEffectiveLLMSettings, resolveLLMProfileId } from "@/lib/llm-settings";
import { FEEDBACK_REPLAY_SNAPSHOT_VERSION, feedbackContextFingerprint } from "@/services/feedback-version-service";

async function reviewedFeedback(
  studentName: string,
  promptContext: string,
  style: FeedbackStyle,
  length: FeedbackLength,
  forbiddenStudentNames: string[] = [],
  signal?: AbortSignal,
) {
  return generateReviewedFeedback({
    studentName,
    promptContext,
    forbiddenStudentNames,
    style,
    length,
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
    const submittedInputRevision = typeof body.inputRevision === "string" ? body.inputRevision.trim() : "";
    const requestedIntensity = typeof body.feedbackIntensity === "string" && FEEDBACK_INTENSITIES.includes(body.feedbackIntensity as FeedbackIntensity)
      ? body.feedbackIntensity as FeedbackIntensity
      : undefined;
    const parsedOutputStrategy = body.outputStrategy === undefined
      ? undefined
      : FeedbackOutputStrategySchema.safeParse(body.outputStrategy);
    if (parsedOutputStrategy && !parsedOutputStrategy.success) {
      return NextResponse.json({ error: "反馈输出策略参数无效", code: "invalid_request", retryable: false }, { status: 400 });
    }
    const outputStrategy = normalizeFeedbackOutputStrategy(parsedOutputStrategy?.data as FeedbackOutputStrategy | undefined);
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
        const routing = await buildFeedbackRouting(prisma, feedbackContext);
        const intensity = requestedIntensity ?? routing.find((item) => item.studentId === studentId)?.baseline ?? "routine";
        if (!outputStrategy.suggestedFeedback) {
          return NextResponse.json({
            feedback: "",
            reviewIssues: ["本批次未选择建议反馈文本，未调用模型"],
          });
        }
        if (intensity === "manual") {
          return NextResponse.json({
            feedback: "",
            reviewStatus: "needs_review",
            reviewIssues: ["已设为人工确认，未调用模型"],
          });
        }

        return NextResponse.json(await withLLMCacheOperation(
          "feedback",
          "生成单人课次反馈",
          async () => {
            // 批量生成返回的课程摘要已经覆盖本班代表性 PDF 结构。单人重写只
            // 收到该生的 PDF，不能据此重建班级摘要；仅在尚无摘要时补建。
            const resolvedLessonMaterial = lessonMaterial?.lessonSummary
              ? lessonMaterial
              : lessonMaterial
              ? await summarizeLessonMaterial({
                  material: lessonMaterial,
                  assessmentEvidence: assessmentEvidence ? { [studentId]: assessmentEvidence } : {},
                  client: createLLMClient("feedbackDraft"),
                  model: getLLMModel("feedbackDraft"),
                  signal: process.env.NODE_ENV === "test" ? undefined : request.signal,
                })
              : undefined;
            const sections = buildFeedbackSections(feedbackContext, routing, assessmentEvidence ? { [studentId]: assessmentEvidence } : {}).get(studentId);
            const promptContext = composeFeedbackPromptContext({
              studentContext: studentContext.promptContext,
              sessionCode,
              studentId,
              lessonMaterial: resolvedLessonMaterial,
              assessmentEvidence,
              sections,
              outputStrategy,
            });
            const forbiddenStudentNames = feedbackContext.students.filter((student) => student.id !== studentId).map((student) => student.name);
            const result = intensity === "routine"
              ? await generateRoutineFeedback({
                  studentName: studentContext.name,
                  promptContext,
                  forbiddenStudentNames,
                  style: outputStrategy.style,
                  length: outputStrategy.length,
                  client: createLLMClient("feedbackReview"),
                  model: getLLMModel("feedbackReview"),
                  signal: process.env.NODE_ENV === "test" ? undefined : request.signal,
                })
              : await reviewedFeedback(
                  studentContext.name,
                  promptContext,
                  outputStrategy.style,
                  outputStrategy.length,
                  forbiddenStudentNames,
                  process.env.NODE_ENV === "test" ? undefined : request.signal,
            );
            if (result.reviewStatus === "needs_review") markCurrentLLMCacheOperationIncomplete();
            if (result.feedback || result.draftFeedback) {
              const profileId = resolveLLMProfileId("feedbackReview");
              const settings = getEffectiveLLMSettings("feedbackReview", profileId ?? undefined);
              const replaySnapshot = {
                version: FEEDBACK_REPLAY_SNAPSHOT_VERSION,
                studentName: studentContext.name,
                promptContext,
                forbiddenStudentNames,
                style: outputStrategy.style,
                length: outputStrategy.length,
                intensity,
                contextFingerprint: feedbackContextFingerprint(studentContext.promptContext),
              };
              const effectiveInputRevision = submittedInputRevision || createHash("sha256")
                .update(JSON.stringify(replaySnapshot))
                .digest("hex")
                .slice(0, 16);
              const stage = intensity === "routine" ? "routine" : "review";
              const variantKey = createHash("sha256").update(JSON.stringify({
                source: "initial",
                sessionId: feedbackContext.session.id,
                studentId,
                stage,
                inputRevision: effectiveInputRevision,
                promptVersion: "feedback-composable-v2",
                modelProfileId: profileId,
                model: settings.model,
                maxTokens: settings.maxTokens ?? null,
                reasoningEnabled: settings.reasoningEnabled ?? false,
                reasoningEffort: settings.reasoningEffort ?? null,
                profileUpdatedAt: settings.updatedAt ?? null,
                style: outputStrategy.style,
                length: outputStrategy.length,
              })).digest("hex");
              await recordSuccessfulGeneration({
                taskType: "feedback", stage,
                semesterId: feedbackContext.session.semesterId, classId: feedbackContext.session.classId,
                sessionId: feedbackContext.session.id, studentId,
                sourceRefs: [{ type: "session", id: feedbackContext.session.id }, { type: "student", id: studentId }],
                promptVersion: "feedback-composable-v2", modelRole: "feedbackReview",
                modelProfileId: profileId,
                inputRevision: effectiveInputRevision,
                variantKey,
                inputSnapshot: replaySnapshot,
                outputSnapshot: { sections, reviewStatus: result.reviewStatus, reviewIssues: result.reviewIssues, draftFeedback: result.draftFeedback, modelRawFinalText: result.feedback },
                finalText: result.feedback || null,
              }).catch(() => undefined);
              await compactHotGenerationRecordsForClass(feedbackContext.session.classId).catch(() => undefined);
            }
            return { ...result, lessonMaterial: resolvedLessonMaterial };
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
        const result = await reviewedFeedback(
          student.name,
          context,
          outputStrategy.style,
          outputStrategy.length,
          [],
          process.env.NODE_ENV === "test" ? undefined : request.signal,
        );
        if (result.reviewStatus === "needs_review") markCurrentLLMCacheOperationIncomplete();
        await recordSuccessfulGeneration({
          taskType: "feedback", stage: "review", classId: student.classId, studentId,
          sourceRefs: [{ type: "student", id: studentId }], promptVersion: "feedback-recent-v1", modelRole: "feedbackReview",
          inputSnapshot: { days: d }, outputSnapshot: { reviewStatus: result.reviewStatus, draftFeedback: result.draftFeedback }, finalText: result.feedback || null,
        }).catch(() => undefined);
        return result;
      },
    ));
  } catch (error) {
    console.error("[/api/report/feedback] error:", error instanceof Error ? error.message : "unknown");
    const apiError = new ApiError("生成反馈失败，请稍后重试", 500, "internal_error", false);
    return NextResponse.json(apiErrorBody(apiError), { status: apiError.status });
  }
}
