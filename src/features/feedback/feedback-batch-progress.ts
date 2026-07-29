import type { FeedbackBatchProgress, FeedbackCard } from "./types";

export function emptyFeedbackBatchProgress(): FeedbackBatchProgress {
  return {
    status: "idle",
    phase: "idle",
    inputRevision: "",
    total: 0,
    completedStudentIds: [],
    failedStudentIds: [],
    interruptionReason: "",
  };
}

function uniqueKnownIds(ids: string[], cards: FeedbackCard[]) {
  const known = new Set(cards.map((card) => card.id));
  return [...new Set(ids)].filter((id) => known.has(id));
}

export function restoreFeedbackBatchProgress(input: {
  saved?: FeedbackBatchProgress;
  cards: FeedbackCard[];
  total: number;
  legacyDone: number;
}): FeedbackBatchProgress {
  if (!input.cards.length && !input.saved) return emptyFeedbackBatchProgress();
  if (input.saved) {
    const completedStudentIds = uniqueKnownIds(input.saved.completedStudentIds, input.cards);
    const failedStudentIds = uniqueKnownIds(input.saved.failedStudentIds, input.cards);
    if (input.saved.status === "running") {
      return {
        ...input.saved,
        status: "incomplete",
        completedStudentIds,
        failedStudentIds,
        interruptionReason: "页面刷新或离开时批次仍在运行",
      };
    }
    return { ...input.saved, completedStudentIds, failedStudentIds };
  }
  const completedStudentIds = input.cards
    .filter((card) => Boolean(card.feedback.trim()) || card.reviewStatus === "edited")
    .map((card) => card.id);
  const complete = input.total > 0 && input.legacyDone >= input.total;
  return {
    status: complete ? "completed" : "incomplete",
    phase: complete ? "completed" : "review",
    inputRevision: "",
    total: input.total,
    completedStudentIds: complete ? input.cards.map((card) => card.id) : completedStudentIds,
    failedStudentIds: input.cards.filter((card) => card.reviewStatus === "needs_review").map((card) => card.id),
    interruptionReason: complete ? "" : "旧版页面状态没有完整批次标记",
  };
}

export function updateStudentProgress(
  progress: FeedbackBatchProgress,
  studentId: string,
  outcome: "completed" | "failed",
): FeedbackBatchProgress {
  const completed = new Set(progress.completedStudentIds);
  const failed = new Set(progress.failedStudentIds);
  if (outcome === "completed") {
    completed.add(studentId);
    failed.delete(studentId);
  } else {
    failed.add(studentId);
  }
  return {
    ...progress,
    completedStudentIds: [...completed],
    failedStudentIds: [...failed],
  };
}

export function remainingFeedbackStudentIds(cards: FeedbackCard[], progress: FeedbackBatchProgress) {
  const completed = new Set(progress.completedStudentIds);
  const failed = new Set(progress.failedStudentIds);
  return cards
    .filter((card) => !completed.has(card.id) || failed.has(card.id))
    .map((card) => card.id);
}

export function feedbackBatchCanExport(progress: FeedbackBatchProgress, forceRegenerate: boolean) {
  return progress.status === "completed"
    && !forceRegenerate
    && progress.total > 0
    && progress.completedStudentIds.length >= progress.total;
}
