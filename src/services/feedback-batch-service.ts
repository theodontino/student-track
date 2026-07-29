import { createHash } from "node:crypto";
import type { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import { getEffectiveLLMSettings, resolveLLMProfileId } from "@/lib/llm-settings";
import { ApiError, apiStreamErrorBody, safeApiError } from "@/lib/api-errors";
import { TtlLruCache } from "@/lib/ttl-lru-cache";
import {
  FeedbackBatchPostSchema,
  FeedbackHistoryStateSchema,
} from "@/lib/contracts/feedback";
import type {
  LessonFeedbackMaterial,
  StudentAssessmentEvidence,
} from "@/lib/feedback-materials";
import {
  buildFeedbackContext,
  type FeedbackContextPreview,
  type FeedbackContextStudent,
} from "@/services/feedback-context-service";
import { buildFeedbackExportWorkbook } from "@/services/feedback-export-service";
import { getAlertDashboard } from "@/services/alert-service";
import {
  composeFeedbackPromptContext,
  generateFeedbackDraft,
  generateRoutineFeedback,
  reviewFeedbackDraft,
  summarizeLessonMaterial,
  type FeedbackReviewStatus,
} from "@/services/feedback-generation-service";
import {
  markCurrentLLMCacheOperationIncomplete,
  withLLMCacheOperation,
} from "@/services/llm-cache-service";
import {
  buildFeedbackRouting,
} from "@/services/feedback-intensity-service";
import type {
  FeedbackIntensity,
  FeedbackRoutingDecision,
} from "@/lib/feedback-intensity";
import {
  feedbackLengthIssue,
  normalizeFeedbackOutputStrategy,
  type FeedbackOutputStrategy,
  type FeedbackSections,
} from "@/lib/feedback-sections";
import { buildFeedbackSections } from "@/services/feedback-sections-service";
import { adoptFeedbackGenerationRecords, compactHotGenerationRecordsForClass, recordSuccessfulGeneration } from "@/services/generation-memory-service";
import { FEEDBACK_REPLAY_SNAPSHOT_VERSION, feedbackContextFingerprint } from "@/services/feedback-version-service";

export type FeedbackBatchInput = z.infer<typeof FeedbackBatchPostSchema>;
export type FeedbackHistoryModule = "feedback" | "report";

interface FeedbackCard {
  id: string;
  name: string;
  labels: string[];
  feedback: string;
  draftFeedback?: string;
  reviewStatus?: FeedbackReviewStatus;
  reviewIssues?: string[];
  feedbackIntensity?: FeedbackIntensity;
  feedbackRoutingReasons?: FeedbackRoutingDecision["reasons"];
  sections?: FeedbackSections;
  contextPreview?: FeedbackContextPreview;
}

interface FeedbackState {
  kind: "batch";
  semesterId: string;
  sessionCode: string;
  className: string;
  students: FeedbackCard[];
  total: number;
  inputRevision?: string;
  batchStatus?: "completed" | "incomplete";
  batchPhase?: "draft" | "review" | "completed";
  completedStudentIds?: string[];
  failedStudentIds?: string[];
  interruptionReason?: string;
  lessonMaterial?: LessonFeedbackMaterial;
  assessmentEvidence?: Record<string, StudentAssessmentEvidence>;
  routingOverrides?: Record<string, FeedbackIntensity>;
  outputStrategy?: FeedbackOutputStrategy;
}

export type FeedbackBatchExecution =
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "stream"; stream: ReadableStream<Uint8Array> };

const cache = new TtlLruCache<string, FeedbackState>({
  ttlMs: 30 * 60 * 1000,
  maxEntries: 100,
});

/** Shared deterministic helpers for the two-stage feedback batch runner. */
export function feedbackBatchConcurrency(env: NodeJS.ProcessEnv = process.env) {
  const fallback = env.NODE_ENV === "test" ? 1 : 2;
  const configured = Number(env.FEEDBACK_LLM_CONCURRENCY || fallback);
  return Math.min(3, Math.max(1, Number.isFinite(configured) ? configured : fallback));
}

export function feedbackBatchWindows<T>(items: T[], size: number) {
  const safeSize = Math.max(1, Math.floor(size));
  return Array.from({ length: Math.ceil(items.length / safeSize) }, (_, windowIndex) =>
    items.slice(windowIndex * safeSize, windowIndex * safeSize + safeSize).map((item, offset) => ({
      item,
      index: windowIndex * safeSize + offset,
    })),
  );
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function parseFeedbackHistoryModule(value: unknown): FeedbackHistoryModule | null {
  if (value === undefined || value === null || value === "report") return "report";
  if (value === "feedback") return "feedback";
  return null;
}

function cacheKey(module: FeedbackHistoryModule, sessionCode: string) {
  return `review-v2:${module}:${sessionCode}`;
}

function normalizeInputs(input: FeedbackBatchInput) {
  const { sessionCode } = input;
  if (input.lessonMaterial?.sessionCode && input.lessonMaterial.sessionCode !== sessionCode) {
    throw new ApiError(
      `课程材料绑定课次 ${input.lessonMaterial.sessionCode}，不能用于 ${sessionCode}`,
      400,
      "invalid_request",
      false,
    );
  }
  const lessonMaterial = input.lessonMaterial
    ? { ...input.lessonMaterial, sessionCode }
    : undefined;
  const assessmentEvidence: Record<string, StudentAssessmentEvidence> = {};
  for (const [studentId, evidence] of Object.entries(input.assessmentEvidence ?? {})) {
    if (evidence.sessionCode && evidence.sessionCode !== sessionCode) {
      throw new ApiError(
        `学生 ${studentId} 的 PDF 证据属于课次 ${evidence.sessionCode}`,
        400,
        "invalid_request",
        false,
      );
    }
    if (evidence.studentId && evidence.studentId !== studentId) {
      throw new ApiError(
        `PDF 证据绑定学生与提交学生 ${studentId} 不一致`,
        400,
        "invalid_request",
        false,
      );
    }
    assessmentEvidence[studentId] = { ...evidence, sessionCode, studentId };
  }
  return { lessonMaterial, assessmentEvidence };
}

function inputRevision(
  lessonMaterial: LessonFeedbackMaterial | undefined,
  assessmentEvidence: Record<string, StudentAssessmentEvidence>,
  routing: FeedbackRoutingDecision[],
  outputStrategy: FeedbackOutputStrategy,
  contextStudents: FeedbackContextStudent[],
) {
  const {
    lessonSummary: _lessonSummary,
    lessonSummarySourceHash: _lessonSummarySourceHash,
    lessonSummaryStatus: _lessonSummaryStatus,
    ...lessonMaterialSource
  } = lessonMaterial ?? {
    lessonSummary: undefined,
    lessonSummarySourceHash: undefined,
    lessonSummaryStatus: undefined,
  };
  void _lessonSummary;
  void _lessonSummarySourceHash;
  void _lessonSummaryStatus;
  const sortedEvidence = Object.fromEntries(
    Object.entries(assessmentEvidence).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash("sha256")
    .update(JSON.stringify({
      lessonMaterial: lessonMaterial ? lessonMaterialSource : null,
      assessmentEvidence: sortedEvidence,
      routing: routing.map(({ studentId, baseline, intensity, reasons }) => ({ studentId, baseline, intensity, reasons })),
      outputStrategy,
      studentContext: contextStudents
        .map((student) => ({ id: student.id, promptContext: student.promptContext }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .digest("hex")
    .slice(0, 16);
}

function parseHistoryState(value: string): FeedbackState | null {
  try {
    const parsed = FeedbackHistoryStateSchema.safeParse(JSON.parse(value));
    if (!parsed.success || parsed.data.kind !== "batch") return null;
    return {
      ...parsed.data,
      outputStrategy: normalizeFeedbackOutputStrategy(parsed.data.outputStrategy),
    } as FeedbackState;
  } catch {
    return null;
  }
}

function submittedCardsFrom(
  submitted: NonNullable<FeedbackBatchInput["students"]>,
  contextByStudent: Map<string, FeedbackContextStudent>,
  outputStrategy: FeedbackOutputStrategy,
): FeedbackCard[] {
  const unknownStudent = submitted.find((item) => !contextByStudent.has(item.id));
  if (unknownStudent) {
    throw new ApiError(
      "反馈卡片包含不属于当前课次班级的学生，未保存任何内容",
      400,
      "invalid_request",
      false,
    );
  }
  if (submitted.length === 0) {
    throw new ApiError("没有可保存的反馈内容", 400, "invalid_request", false);
  }

  return submitted.map((item) => {
    const student = contextByStudent.get(item.id);
    if (!student) {
      throw new ApiError("反馈卡片学生校验失败", 400, "invalid_request", false);
    }
    const feedback = item.feedback.trim();
    const lengthIssue = feedback ? feedbackLengthIssue(feedback, outputStrategy.length) : null;
    return {
      id: student.id,
      name: student.name,
      labels: student.labels,
      feedback,
      draftFeedback: item.draftFeedback?.trim(),
      reviewStatus: lengthIssue ? "needs_review" : item.reviewStatus,
      reviewIssues: lengthIssue
        ? [...new Set([...(item.reviewIssues ?? []), lengthIssue])].slice(0, 8)
        : item.reviewIssues?.slice(0, 8),
      feedbackIntensity: item.feedbackIntensity,
      feedbackRoutingReasons: item.feedbackRoutingReasons,
      sections: item.sections,
      contextPreview: student.preview,
    };
  });
}

async function persistState(
  module: FeedbackHistoryModule,
  state: FeedbackState,
  title: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new DOMException("反馈生成已取消", "AbortError");
  await prisma.workHistory.create({
    data: {
      module,
      key: state.sessionCode,
      title,
      state: JSON.stringify(state),
    },
  });
  if (signal?.aborted) throw new DOMException("反馈生成已取消", "AbortError");
  cache.set(cacheKey(module, state.sessionCode), state);
}

export async function buildFeedbackBatchExport(
  sessionCode: string,
  module: FeedbackHistoryModule,
) {
  const key = cacheKey(module, sessionCode);
  let state = cache.get(key) ?? null;
  if (!state) {
    const history = await prisma.workHistory.findFirst({
      where: { module, key: sessionCode },
      orderBy: { createdAt: "desc" },
    });
    state = history ? parseHistoryState(history.state) : null;
  }
  if (!state) throw new ApiError("尚未生成反馈", 404, "not_found", false);
  if (
    state.batchStatus === "incomplete"
    || state.students.length < state.total
    || (state.completedStudentIds && state.completedStudentIds.length < state.total)
  ) {
    throw new ApiError("当前批次尚未完成，不能导出", 409, "conflict", false);
  }
  const outputStrategy = normalizeFeedbackOutputStrategy(state.outputStrategy);
  if (!outputStrategy.suggestedFeedback) {
    throw new ApiError("本批次仅生成教师研判，未生成家长反馈文本", 409, "conflict", false);
  }

  const session = await prisma.classSession.findUnique({ where: { code: sessionCode }, select: { id: true } });
  const selectedVersions = session ? await prisma.feedbackGenerationSelection.findMany({
    where: { sessionId: session.id },
    include: { selectedGeneration: true },
  }) : [];
  const selectedByStudent = new Map(selectedVersions.map((selection) => [
    selection.studentId,
    selection.selectedGeneration,
  ]));
  const exportStudents = state.students.map((card) => {
    const selected = selectedByStudent.get(card.id);
    if (!selected?.finalText?.trim()) return card;
    let reviewStatus = card.reviewStatus;
    let reviewIssues = card.reviewIssues;
    const teacherEditedSelected = card.reviewStatus === "edited"
      && card.feedback.trim() === selected.finalText.trim();
    if (!teacherEditedSelected) {
      try {
        const output = selected.outputSnapshot ? JSON.parse(selected.outputSnapshot) as {
          reviewStatus?: FeedbackReviewStatus;
          reviewIssues?: string[];
        } : null;
        reviewStatus = output?.reviewStatus ?? reviewStatus;
        reviewIssues = output?.reviewIssues ?? reviewIssues;
      } catch {
        // Keep the persisted card review state if an old output snapshot is unreadable.
      }
    }
    if (state.inputRevision && selected.inputRevision !== state.inputRevision) {
      reviewStatus = "needs_review";
      reviewIssues = ["当前采用版本的输入已变化"];
    }
    return { ...card, feedback: selected.finalText.trim(), reviewStatus, reviewIssues };
  });

  const reviewBlockerCount = exportStudents.filter((card) => (
    card.reviewStatus === "needs_review"
    || Boolean(feedbackLengthIssue(card.feedback, outputStrategy.length))
  )).length;
  if (reviewBlockerCount > 0) {
    throw new ApiError(
      `还有 ${reviewBlockerCount} 条反馈需要人工确认，暂不能导出`,
      409,
      "conflict",
      false,
    );
  }
  if (session) await adoptFeedbackGenerationRecords({ sessionId: session.id, students: exportStudents.map((card) => ({ id: card.id, feedback: card.feedback })) }).catch(() => undefined);
  const dashboard = await getAlertDashboard({ semesterId: state.semesterId });
  return buildFeedbackExportWorkbook(
    prisma,
    sessionCode,
    exportStudents,
    dashboard.studentRisks,
  );
}

function createGenerationStream(input: {
  sessionCode: string;
  historyModule: FeedbackHistoryModule;
  revision: string;
  lessonMaterial?: LessonFeedbackMaterial;
  assessmentEvidence: Record<string, StudentAssessmentEvidence>;
  routing: FeedbackRoutingDecision[];
  outputStrategy: FeedbackOutputStrategy;
  sectionsByStudent: Map<string, FeedbackSections>;
  feedbackContext: Awaited<ReturnType<typeof buildFeedbackContext>>;
  contextByStudent: Map<string, FeedbackContextStudent>;
  signal?: AbortSignal;
}) {
  const {
    sessionCode,
    historyModule,
    revision,
    lessonMaterial,
    assessmentEvidence,
    routing,
    outputStrategy,
    sectionsByStudent,
    feedbackContext,
    contextByStudent,
    signal,
  } = input;
  const draftClient = outputStrategy.suggestedFeedback ? createLLMClient("feedbackDraft") : null;
  const draftModel = outputStrategy.suggestedFeedback ? getLLMModel("feedbackDraft") : "";
  const reviewClient = outputStrategy.suggestedFeedback ? createLLMClient("feedbackReview") : null;
  const reviewModel = outputStrategy.suggestedFeedback ? getLLMModel("feedbackReview") : "";
  const routingByStudent = new Map(routing.map((item) => [item.studentId, item]));
  const total = feedbackContext.total;
  const cards: FeedbackCard[] = feedbackContext.students.map((student) => ({
    id: student.id,
    name: student.name,
    labels: student.labels,
    feedback: "",
    contextPreview: student.preview,
    feedbackIntensity: routingByStudent.get(student.id)?.intensity ?? "routine",
    feedbackRoutingReasons: routingByStudent.get(student.id)?.reasons ?? [],
    sections: sectionsByStudent.get(student.id),
  }));
  const encoder = new TextEncoder();
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("反馈生成已取消", "AbortError");
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await withLLMCacheOperation("feedback", "批量分析并生成家长反馈", async () => {
          throwIfAborted();
          const resolvedLessonMaterial = (
            outputStrategy.suggestedFeedback
            && lessonMaterial
            && draftClient
          )
            ? await summarizeLessonMaterial({
                material: lessonMaterial,
                assessmentEvidence,
                client: draftClient,
                model: draftModel,
                signal,
              })
            : lessonMaterial;
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "init", students: cards, total, inputRevision: revision })}\n`));

          const concurrency = feedbackBatchConcurrency();
          for (const window of feedbackBatchWindows(cards, concurrency)) {
            throwIfAborted();
            await Promise.all(window.map(async ({ item: card }) => {
              if (!outputStrategy.suggestedFeedback) {
                card.reviewIssues = ["本批次为教师研判模式，未调用模型成文"];
                return;
              }
              if (!reviewClient) throw new Error("反馈成稿模型未配置");
              if (card.feedbackIntensity === "manual") {
                card.reviewStatus = "needs_review";
                card.reviewIssues = ["已设为人工确认，未调用模型"];
                return;
              }
              const studentContext = contextByStudent.get(card.id);
              try {
                const promptContext = composeFeedbackPromptContext({
                  studentContext: studentContext?.promptContext ?? card.name,
                  sessionCode,
                  studentId: card.id,
                  lessonMaterial: resolvedLessonMaterial,
                  assessmentEvidence: assessmentEvidence[card.id],
                  sections: card.sections,
                  outputStrategy,
                });
                if (card.feedbackIntensity === "routine") {
                  Object.assign(card, await generateRoutineFeedback({
                    studentName: card.name,
                    promptContext,
                    forbiddenStudentNames: cards.filter((item) => item.id !== card.id).map((item) => item.name),
                    style: outputStrategy.style,
                    length: outputStrategy.length,
                    client: reviewClient,
                    model: reviewModel,
                    signal,
                  }));
                } else {
                  card.draftFeedback = await generateFeedbackDraft({
                    studentName: card.name,
                    promptContext,
                    style: outputStrategy.style,
                    length: outputStrategy.length,
                    client: draftClient ?? reviewClient,
                    model: draftModel,
                    signal,
                  });
                  card.feedback = "";
                }
              } catch (error) {
                if (signal?.aborted || isAbortError(error)) throw error;
                console.error(
                  "[feedback-batch] draft failed:",
                  error instanceof Error ? error.message : "unknown",
                );
                card.feedback = "";
                card.reviewStatus = "needs_review";
                card.reviewIssues = ["内部分析模型生成失败，请单独重写或人工填写"];
              }
            }));
            throwIfAborted();
            for (const { item: card, index } of window) {
              controller.enqueue(encoder.encode(`${JSON.stringify({
                type: "draft",
                studentId: card.id,
                name: card.name,
                feedback: card.feedback,
                draftFeedback: card.draftFeedback,
                reviewStatus: card.reviewStatus,
                reviewIssues: card.reviewIssues,
                completed: index + 1,
                total,
              })}\n`));
            }
          }

          const reviewCards = cards.filter((card) => (
            outputStrategy.suggestedFeedback
            &&
            card.feedbackIntensity !== "routine" && card.feedbackIntensity !== "manual" && Boolean(card.draftFeedback)
          ));
          for (const window of feedbackBatchWindows(reviewCards, concurrency)) {
            throwIfAborted();
            await Promise.all(window.map(async ({ item: card }) => {
              if (!card.draftFeedback) return;
              if (!reviewClient) throw new Error("反馈成稿模型未配置");
              const studentContext = contextByStudent.get(card.id);
              const promptContext = composeFeedbackPromptContext({
                studentContext: studentContext?.promptContext ?? card.name,
                sessionCode,
                studentId: card.id,
                lessonMaterial: resolvedLessonMaterial,
                assessmentEvidence: assessmentEvidence[card.id],
                sections: card.sections,
                outputStrategy,
              });
              try {
                const reviewed = await reviewFeedbackDraft({
                  studentName: card.name,
                  promptContext,
                  forbiddenStudentNames: cards
                    .filter((item) => item.id !== card.id)
                    .map((item) => item.name),
                  style: outputStrategy.style,
                  length: outputStrategy.length,
                  draftFeedback: card.draftFeedback,
                  client: reviewClient,
                  model: reviewModel,
                  signal,
                });
                Object.assign(card, reviewed);
              } catch (error) {
                if (signal?.aborted || isAbortError(error)) throw error;
                card.feedback = "";
                card.reviewStatus = "needs_review";
                card.reviewIssues = ["成稿审核失败，请人工确认或重试"];
              }
            }));
            throwIfAborted();
            for (const { item: card, index } of window) {
              controller.enqueue(encoder.encode(`${JSON.stringify({
                type: "review",
                studentId: card.id,
                name: card.name,
                feedback: card.feedback,
                draftFeedback: card.draftFeedback,
                reviewStatus: card.reviewStatus,
                reviewIssues: card.reviewIssues,
                completed: index + 1,
                total,
              })}\n`));
            }
          }

          if (cards.some((card) => card.reviewStatus === "needs_review")) {
            markCurrentLLMCacheOperationIncomplete();
          }
          throwIfAborted();
          const state: FeedbackState = {
            kind: "batch",
            semesterId: feedbackContext.session.semesterId,
            sessionCode,
            className: feedbackContext.className,
            students: cards,
            total,
            inputRevision: revision,
            batchStatus: "completed",
            batchPhase: "completed",
            completedStudentIds: cards.map((card) => card.id),
            failedStudentIds: cards.filter((card) => card.reviewStatus === "needs_review").map((card) => card.id),
            lessonMaterial: resolvedLessonMaterial,
            assessmentEvidence,
            routingOverrides: Object.fromEntries(routing
              .filter((item) => item.intensity !== item.baseline)
              .map((item) => [item.studentId, item.intensity])),
            outputStrategy,
          };
          // Store business-valid LLM results separately from recoverable page history.
          // Teacher-only mode intentionally has no model result to record.
          if (outputStrategy.suggestedFeedback) {
            await Promise.all(cards.flatMap((card) => {
              const sourceRefs = [
                { type: "session" as const, id: feedbackContext.session.id },
                { type: "student" as const, id: card.id },
              ];
              const promptContext = composeFeedbackPromptContext({
                studentContext: contextByStudent.get(card.id)?.promptContext ?? card.name,
                sessionCode,
                studentId: card.id,
                lessonMaterial: resolvedLessonMaterial,
                assessmentEvidence: assessmentEvidence[card.id],
                sections: card.sections,
                outputStrategy,
              });
              const replaySnapshot = {
                version: FEEDBACK_REPLAY_SNAPSHOT_VERSION,
                studentName: card.name,
                promptContext,
                forbiddenStudentNames: cards.filter((item) => item.id !== card.id).map((item) => item.name),
                style: outputStrategy.style,
                length: outputStrategy.length,
                intensity: card.feedbackIntensity ?? "routine",
                contextFingerprint: feedbackContextFingerprint(
                  contextByStudent.get(card.id)?.promptContext ?? card.name,
                ),
              };
              const shared = {
                taskType: "feedback" as const,
                semesterId: feedbackContext.session.semesterId,
                classId: feedbackContext.session.classId,
                sessionId: feedbackContext.session.id,
                studentId: card.id,
                sourceRefs,
                promptVersion: "feedback-composable-v2",
                inputRevision: revision,
                inputSnapshot: replaySnapshot,
              };
              if (card.feedbackIntensity === "routine" && card.feedback) {
                const profileId = resolveLLMProfileId("feedbackReview");
                const settings = getEffectiveLLMSettings("feedbackReview", profileId ?? undefined);
                const variantKey = createHash("sha256").update(JSON.stringify({
                  source: "initial",
                  sessionId: feedbackContext.session.id,
                  studentId: card.id,
                  stage: "routine",
                  inputRevision: revision,
                  promptVersion: shared.promptVersion,
                  modelProfileId: profileId,
                  model: settings.model,
                  maxTokens: settings.maxTokens ?? null,
                  reasoningEnabled: settings.reasoningEnabled ?? false,
                  reasoningEffort: settings.reasoningEffort ?? null,
                  profileUpdatedAt: settings.updatedAt ?? null,
                })).digest("hex");
                return [recordSuccessfulGeneration({ ...shared, stage: "routine", modelRole: "feedbackReview", modelProfileId: profileId, variantKey, outputSnapshot: { sections: card.sections, reviewStatus: card.reviewStatus, reviewIssues: card.reviewIssues, modelRawFinalText: card.feedback }, finalText: card.feedback })];
              }
              const records = [];
              if (card.draftFeedback) records.push(recordSuccessfulGeneration({ ...shared, stage: "draft", modelRole: "feedbackDraft", selectIfFirst: false, outputSnapshot: { sections: card.sections, draftFeedback: card.draftFeedback } }));
              if (card.feedback) {
                const profileId = resolveLLMProfileId("feedbackReview");
                const settings = getEffectiveLLMSettings("feedbackReview", profileId ?? undefined);
                const variantKey = createHash("sha256").update(JSON.stringify({
                  source: "initial",
                  sessionId: feedbackContext.session.id,
                  studentId: card.id,
                  stage: "review",
                  inputRevision: revision,
                  promptVersion: shared.promptVersion,
                  modelProfileId: profileId,
                  model: settings.model,
                  maxTokens: settings.maxTokens ?? null,
                  reasoningEnabled: settings.reasoningEnabled ?? false,
                  reasoningEffort: settings.reasoningEffort ?? null,
                  profileUpdatedAt: settings.updatedAt ?? null,
                })).digest("hex");
                records.push(recordSuccessfulGeneration({ ...shared, stage: "review", modelRole: "feedbackReview", modelProfileId: profileId, variantKey, outputSnapshot: { sections: card.sections, reviewStatus: card.reviewStatus, reviewIssues: card.reviewIssues, draftFeedback: card.draftFeedback, modelRawFinalText: card.feedback }, finalText: card.feedback }));
              }
              return records;
            })).catch(() => undefined);
            // This scan is deterministic and does not call the model. A history failure must not invalidate feedback.
            await compactHotGenerationRecordsForClass(feedbackContext.session.classId).catch(() => undefined);
          }
          await persistState(
            historyModule,
            state,
            `${feedbackContext.className} ${sessionCode} 批量反馈`,
            signal,
          );
          throwIfAborted();
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done", ...state })}\n`));
        });
        controller.close();
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          controller.close();
          return;
        }
        const failure = safeApiError(error, "批量生成失败");
        console.error("[feedback-batch] stream error:", error instanceof Error ? error.message : "unknown");
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "error",
          ...apiStreamErrorBody(failure),
        })}\n`));
        controller.close();
      }
    },
  });
}

export async function executeFeedbackBatch(
  input: FeedbackBatchInput,
  signal?: AbortSignal,
): Promise<FeedbackBatchExecution> {
  const historyModule = parseFeedbackHistoryModule(input.historyModule);
  if (!historyModule) {
    throw new ApiError("无效的历史模块", 400, "invalid_request", false);
  }
  if (signal?.aborted) throw new ApiError("反馈生成已取消", 499, "cancelled", false);

  const normalized = normalizeInputs(input);
  const feedbackContext = await buildFeedbackContext(prisma, input.sessionCode);
  const contextByStudent = new Map(
    feedbackContext.students.map((student) => [student.id, student]),
  );
  const unknownOverrideStudent = Object.keys(input.routingOverrides ?? {})
    .find((studentId) => !contextByStudent.has(studentId));
  if (unknownOverrideStudent) {
    throw new ApiError("反馈档位包含不属于当前课次班级的学生", 400, "invalid_request", false);
  }
  const routing = await buildFeedbackRouting(prisma, feedbackContext);
  const routingByStudent = new Map(routing.map((item) => [item.studentId, item]));
  for (const [studentId, intensity] of Object.entries(input.routingOverrides ?? {})) {
    const decision = routingByStudent.get(studentId);
    if (decision) decision.intensity = intensity;
  }
  const outputStrategy = normalizeFeedbackOutputStrategy(
    input.outputStrategy && typeof input.outputStrategy === "object"
      ? input.outputStrategy as Partial<FeedbackOutputStrategy>
      : undefined,
  );
  const revision = inputRevision(
    normalized.lessonMaterial,
    normalized.assessmentEvidence,
    routing,
    outputStrategy,
    feedbackContext.students,
  );
  const key = cacheKey(historyModule, input.sessionCode);
  const cached = cache.get(key);
  const foreignEvidenceStudent = Object.keys(normalized.assessmentEvidence)
    .find((studentId) => !contextByStudent.has(studentId));
  if (foreignEvidenceStudent) {
    throw new ApiError(
      "PDF 证据包含不属于当前课次班级的学生",
      400,
      "invalid_request",
      false,
    );
  }
  if (input.revisionOnly === true) {
    return { kind: "json", body: { inputRevision: revision, total: feedbackContext.total } };
  }
  if (
    input.saveState !== true
    && input.bypassCache !== true
    && cached
    && cached.inputRevision === revision
    && cached.batchStatus !== "incomplete"
  ) {
    return { kind: "json", body: { cached: true, ...cached } };
  }

  if (input.saveState === true) {
    if (input.inputRevision && input.inputRevision !== revision) {
      throw new ApiError(
        "反馈输入已经变化，旧部分结果不能与当前批次合并",
        409,
        "conflict",
        false,
      );
    }
    const cards = submittedCardsFrom(input.students ?? [], contextByStudent, outputStrategy);
    const submittedIds = new Set(cards.map((card) => card.id));
    const completedStudentIds = [...new Set(input.completedStudentIds ?? [])];
    const failedStudentIds = [...new Set(input.failedStudentIds ?? [])];
    if (submittedIds.size !== cards.length) {
      throw new ApiError("反馈卡片包含重复学生，未保存任何内容", 400, "invalid_request", false);
    }
    if (input.savePartial === true) {
      if (!input.inputRevision) {
        throw new ApiError("部分批次缺少输入版本，未保存任何内容", 400, "invalid_request", false);
      }
      const invalidCompletedId = completedStudentIds.find((studentId) => !submittedIds.has(studentId));
      const invalidFailedId = failedStudentIds.find((studentId) => !submittedIds.has(studentId));
      if (invalidCompletedId || invalidFailedId) {
        throw new ApiError("部分批次状态引用了未知学生，未保存任何内容", 400, "invalid_request", false);
      }
      if (!completedStudentIds.length) {
        throw new ApiError("当前没有可保存的已处理学生结果", 400, "invalid_request", false);
      }
      if (completedStudentIds.some((studentId) => failedStudentIds.includes(studentId))) {
        throw new ApiError("同一学生不能同时标记为已完成和失败", 400, "invalid_request", false);
      }
      if (outputStrategy.suggestedFeedback && completedStudentIds.some((studentId) => {
        const card = cards.find((item) => item.id === studentId);
        return !card?.feedback.trim() || card.reviewStatus === "needs_review";
      })) {
        throw new ApiError("部分批次包含尚未完成的学生文本，未保存任何内容", 400, "invalid_request", false);
      }
    } else {
      const contextIds = new Set(feedbackContext.students.map((student) => student.id));
      if (cards.length !== feedbackContext.total || cards.some((card) => !contextIds.has(card.id))) {
        throw new ApiError("完整批次缺少学生结果，未保存任何内容", 400, "invalid_request", false);
      }
      if (outputStrategy.suggestedFeedback && cards.some((card) => !card.feedback.trim())) {
        throw new ApiError("完整批次仍有空白学生反馈，未保存任何内容", 400, "invalid_request", false);
      }
    }
    const state: FeedbackState = {
      kind: "batch",
      semesterId: feedbackContext.session.semesterId,
      sessionCode: input.sessionCode,
      className: feedbackContext.className,
      students: cards,
      total: feedbackContext.total,
      inputRevision: revision,
      batchStatus: input.savePartial === true ? "incomplete" : "completed",
      batchPhase: input.savePartial === true ? "review" : "completed",
      completedStudentIds: input.savePartial === true
        ? completedStudentIds
        : cards.map((card) => card.id),
      failedStudentIds,
      interruptionReason: input.savePartial === true
        ? input.interruptionReason || "教师保存了未完成批次"
        : undefined,
      lessonMaterial: normalized.lessonMaterial,
      assessmentEvidence: normalized.assessmentEvidence,
      routingOverrides: input.routingOverrides,
      outputStrategy,
    };
    await persistState(
      historyModule,
      state,
      `${feedbackContext.className} ${input.sessionCode} 保存反馈`,
      signal,
    );
    return { kind: "json", body: { saved: true, ...state } };
  }

  return {
    kind: "stream",
    stream: createGenerationStream({
      sessionCode: input.sessionCode,
      historyModule,
      revision,
      lessonMaterial: normalized.lessonMaterial,
      assessmentEvidence: normalized.assessmentEvidence,
      feedbackContext,
      contextByStudent,
      routing,
      outputStrategy,
      sectionsByStudent: buildFeedbackSections(feedbackContext, routing, normalized.assessmentEvidence),
      signal,
    }),
  };
}
