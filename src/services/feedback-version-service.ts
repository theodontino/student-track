import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import {
  FEEDBACK_LENGTHS,
  FEEDBACK_STYLES,
  type FeedbackLength,
  type FeedbackStyle,
} from "@/lib/feedback-sections";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import {
  getSafeLLMProfileSummaries,
  getSafeLLMProfileSummary,
  type SafeLLMProfileSummary,
} from "@/lib/llm-settings";
import { prisma } from "@/lib/prisma";
import {
  generateReviewedFeedback,
  generateRoutineFeedback,
} from "@/services/feedback-generation-service";
import { buildFeedbackContext } from "@/services/feedback-context-service";
import { recordSuccessfulGeneration } from "@/services/generation-memory-service";

export const FEEDBACK_REPLAY_SNAPSHOT_VERSION = 1;

export interface FeedbackReplaySnapshot {
  version: 1;
  studentName: string;
  promptContext: string;
  forbiddenStudentNames: string[];
  style: FeedbackStyle;
  length: FeedbackLength;
  intensity: string;
  contextFingerprint: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function feedbackVariantKey(input: {
  sourceGenerationId: string;
  profile: SafeLLMProfileSummary;
  promptVersion: string;
  inputRevision: string;
}) {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export function feedbackContextFingerprint(promptContext: string) {
  return createHash("sha256").update(promptContext).digest("hex");
}

export function parseFeedbackReplaySnapshot(value: string | null): FeedbackReplaySnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.version !== FEEDBACK_REPLAY_SNAPSHOT_VERSION
      || typeof parsed.studentName !== "string"
      || typeof parsed.promptContext !== "string"
      || !Array.isArray(parsed.forbiddenStudentNames)
      || !parsed.forbiddenStudentNames.every((item) => typeof item === "string")
      || typeof parsed.style !== "string"
      || !FEEDBACK_STYLES.includes(parsed.style as FeedbackStyle)
      || typeof parsed.length !== "string"
      || !FEEDBACK_LENGTHS.includes(parsed.length as FeedbackLength)
      || typeof parsed.intensity !== "string"
      || typeof parsed.contextFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(parsed.contextFingerprint)
    ) return null;
    return parsed as unknown as FeedbackReplaySnapshot;
  } catch {
    return null;
  }
}

async function latestBatchInputRevision(sessionCode: string, db: PrismaClient) {
  const histories = await db.workHistory.findMany({
    where: { module: { in: ["feedback", "report"] }, key: sessionCode },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { state: true },
  });
  for (const history of histories) {
    try {
      const parsed = JSON.parse(history.state) as { inputRevision?: unknown };
      if (typeof parsed.inputRevision === "string") return parsed.inputRevision;
    } catch {
      // A malformed or unrelated history snapshot must not hide an earlier
      // valid batch revision for the same session.
    }
  }
  return null;
}

function reviewStatusFromSnapshot(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { reviewStatus?: unknown };
    return typeof parsed.reviewStatus === "string" ? parsed.reviewStatus : null;
  } catch {
    return null;
  }
}

export async function listFeedbackVersions(input: {
  sessionCode: string;
  studentId?: string;
}, db: PrismaClient = prisma) {
  const session = await db.classSession.findUnique({
    where: { code: input.sessionCode },
    select: { id: true },
  });
  if (!session) throw new ApiError("课次不存在", 404, "not_found", false);
  const [records, selections, currentRevision] = await Promise.all([
    db.generationRecord.findMany({
      where: {
        taskType: "feedback",
        sessionId: session.id,
        ...(input.studentId ? { studentId: input.studentId } : {}),
        stage: { in: ["routine", "review"] },
      },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
    }),
    db.feedbackGenerationSelection.findMany({
      where: {
        sessionId: session.id,
        ...(input.studentId ? { studentId: input.studentId } : {}),
      },
    }),
    latestBatchInputRevision(input.sessionCode, db),
  ]);
  const selectedByStudent = new Map(selections.map((item) => [item.studentId, item.selectedGenerationId]));
  const profiles = new Map(getSafeLLMProfileSummaries().map((profile) => [profile.id, profile]));
  return {
    sessionCode: input.sessionCode,
    versions: records.map((record) => {
      const replay = parseFeedbackReplaySnapshot(record.inputSnapshot);
      const stale = !record.inputRevision || !currentRevision || record.inputRevision !== currentRevision;
      return {
        id: record.id,
        studentId: record.studentId,
        parentGenerationId: record.parentGenerationId,
        modelProfileId: record.modelProfileId,
        modelProfileName: record.modelProfileId ? profiles.get(record.modelProfileId)?.name ?? null : null,
        modelName: record.modelName,
        generatedAt: record.generatedAt.toISOString(),
        selected: Boolean(record.studentId && selectedByStudent.get(record.studentId) === record.id),
        finalText: record.finalText ?? "",
        reviewStatus: reviewStatusFromSnapshot(record.outputSnapshot),
        replayable: record.lifecycle === "hot" && Boolean(record.inputRevision && replay),
        stale,
        replayState: !record.inputRevision || !replay
          ? "缺少可重放输入"
          : stale
            ? "当前输入已变化"
            : "可重放",
      };
    }),
  };
}

export async function regenerateFeedbackVersions(input: {
  profileId: string;
  items: Array<{ studentId: string; sourceGenerationId: string }>;
}, db: PrismaClient = prisma) {
  const profile = getSafeLLMProfileSummary(input.profileId);
  const results = [];
  for (const item of input.items) {
    try {
      const source = await db.generationRecord.findUnique({ where: { id: item.sourceGenerationId } });
      if (
        !source
        || source.taskType !== "feedback"
        || !["routine", "review"].includes(source.stage)
        || source.studentId !== item.studentId
        || !source.sessionId
      ) {
        throw new ApiError("源反馈版本不存在或与学生不匹配", 404, "not_found", false);
      }
      const replay = parseFeedbackReplaySnapshot(source.inputSnapshot);
      if (!source.inputRevision || !replay) {
        throw new ApiError("该版本缺少可重放输入", 409, "conflict", false);
      }
      const session = await db.classSession.findUnique({
        where: { id: source.sessionId },
        select: { code: true },
      });
      if (!session) throw new ApiError("源反馈课次不存在", 409, "conflict", false);
      const currentRevision = await latestBatchInputRevision(session.code, db);
      if (!currentRevision || currentRevision !== source.inputRevision) {
        throw new ApiError("当前输入已变化，请重新生成整批反馈", 409, "conflict", false);
      }
      const currentContext = await buildFeedbackContext(db, session.code);
      const currentStudent = currentContext.students.find((student) => student.id === item.studentId);
      if (
        !currentStudent
        || feedbackContextFingerprint(currentStudent.promptContext) !== replay.contextFingerprint
      ) {
        throw new ApiError("当前学生证据已变化，请重新生成整批反馈", 409, "conflict", false);
      }
      const variantKey = feedbackVariantKey({
        sourceGenerationId: source.id,
        profile,
        promptVersion: source.promptVersion,
        inputRevision: source.inputRevision,
      });
      const existing = await db.generationRecord.findUnique({ where: { variantKey } });
      if (existing) {
        results.push({ studentId: item.studentId, status: "existing", generationId: existing.id });
        continue;
      }
      const client = createLLMClient("feedbackReview", input.profileId);
      const model = getLLMModel("feedbackReview", input.profileId);
      const generated = source.stage === "routine"
        ? await generateRoutineFeedback({
            studentName: replay.studentName,
            promptContext: replay.promptContext,
            forbiddenStudentNames: replay.forbiddenStudentNames,
            style: replay.style,
            length: replay.length,
            profileId: input.profileId,
            client,
            model,
          })
        : await generateReviewedFeedback({
            studentName: replay.studentName,
            promptContext: replay.promptContext,
            forbiddenStudentNames: replay.forbiddenStudentNames,
            style: replay.style,
            length: replay.length,
            profileId: input.profileId,
            draftClient: createLLMClient("feedbackDraft", input.profileId),
            draftModel: getLLMModel("feedbackDraft", input.profileId),
            reviewClient: client,
            reviewModel: model,
          });
      if (!generated.feedback && !generated.draftFeedback) {
        throw new ApiError("指定模型未生成可保存的反馈版本", 502, "internal_error", true);
      }
      const record = await recordSuccessfulGeneration({
        taskType: "feedback",
        stage: source.stage,
        semesterId: source.semesterId,
        classId: source.classId,
        sessionId: source.sessionId,
        studentId: source.studentId,
        sourceRefs: [{ type: "generation", id: source.id }],
        promptVersion: source.promptVersion,
        modelRole: "feedbackReview",
        modelProfileId: input.profileId,
        inputRevision: source.inputRevision,
        parentGenerationId: source.id,
        variantKey,
        selectIfFirst: false,
        inputSnapshot: replay,
        outputSnapshot: {
          reviewStatus: generated.reviewStatus,
          reviewIssues: generated.reviewIssues,
          draftFeedback: generated.draftFeedback,
          modelRawFinalText: generated.feedback,
        },
        finalText: generated.feedback || null,
      }, db);
      results.push({
        studentId: item.studentId,
        status: "created",
        generationId: record.id,
        reviewStatus: generated.reviewStatus,
      });
    } catch (error) {
      const failure = error instanceof ApiError
        ? error
        : new ApiError(error instanceof Error ? error.message : "生成派生版本失败", 500, "internal_error", false);
      results.push({
        studentId: item.studentId,
        status: "error",
        error: failure.message,
        code: failure.code,
      });
    }
  }
  return { profile: { id: profile.id, name: profile.name, model: profile.model }, results };
}

export async function selectFeedbackVersion(input: {
  sessionCode: string;
  studentId: string;
  generationId: string;
}, db: PrismaClient = prisma) {
  const session = await db.classSession.findUnique({
    where: { code: input.sessionCode },
    select: { id: true },
  });
  if (!session) throw new ApiError("课次不存在", 404, "not_found", false);
  const generation = await db.generationRecord.findUnique({ where: { id: input.generationId } });
  if (
    !generation
    || generation.taskType !== "feedback"
    || generation.sessionId !== session.id
    || generation.studentId !== input.studentId
    || !["routine", "review"].includes(generation.stage)
  ) {
    throw new ApiError("反馈版本与当前课次或学生不匹配", 400, "invalid_request", false);
  }
  const replay = parseFeedbackReplaySnapshot(generation.inputSnapshot);
  const currentRevision = await latestBatchInputRevision(input.sessionCode, db);
  if (!generation.inputRevision || !replay) {
    throw new ApiError("1.0 旧记录缺少可重放输入，仅可只读查看", 409, "conflict", false);
  }
  if (!currentRevision || currentRevision !== generation.inputRevision) {
    throw new ApiError("当前输入已变化，不能采用旧输入版本", 409, "conflict", false);
  }
  if (!generation.finalText?.trim()) {
    throw new ApiError("该版本没有可采用的最终文本", 409, "conflict", false);
  }
  const selectedAt = new Date();
  await db.$transaction([
    db.feedbackGenerationSelection.upsert({
      where: { sessionId_studentId: { sessionId: session.id, studentId: input.studentId } },
      create: {
        sessionId: session.id,
        studentId: input.studentId,
        selectedGenerationId: generation.id,
        selectedAt,
      },
      update: {
        selectedGenerationId: generation.id,
        selectedAt,
      },
    }),
    db.generationRecord.update({
      where: { id: generation.id },
      data: { adoptedAt: selectedAt },
    }),
  ]);
  return {
    generationId: generation.id,
    studentId: input.studentId,
    finalText: generation.finalText,
    reviewStatus: reviewStatusFromSnapshot(generation.outputSnapshot),
    selectedAt: selectedAt.toISOString(),
  };
}
