import {
  feedbackGenerationApproachLabel,
  feedbackGenerationExecutionPublicView,
  normalizeStoredFeedbackGenerationApproach
} from "@/lib/feedback-generation-approach";
import {
  FeedbackAuditSnapshotSchema,
  FeedbackCompositionPlanSchema,
  FeedbackEvidenceBundleSchema,
  FeedbackPlanInputSnapshotSchema,
  sanitizeFeedbackComposition,
  sanitizeFeedbackEvidenceBundle
} from "@/lib/feedback-plan";
import { feedbackPlanActionBucket } from "@/lib/feedback-plan-summary";
import { stripFeedbackInternalBoundary } from "@/lib/feedback-text-safety";
import { generationProgress, parseCompositionSnapshot, parseGenerationConfigSnapshot, parseJson } from "@/services/feedback-plan/model";


function generationTiming(plan: {
  generationElapsedMs?: number;
  generationRunStartedAt?: Date | null;
  generationStartedAt?: Date | null;
  generationCompletedAt?: Date | null;
  items: Array<{ status: string; generationDurationMs?: number | null }>;
}) {
  const now = new Date();
  const elapsedMs = Math.max(0, (plan.generationElapsedMs ?? 0) + (
    plan.generationRunStartedAt ? now.getTime() - plan.generationRunStartedAt.getTime() : 0
  ));
  const durations = plan.items.flatMap((item) => (
    item.status !== "generation_failed" && typeof item.generationDurationMs === "number"
      ? [item.generationDurationMs]
      : []
  ));
  return {
    startedAt: plan.generationStartedAt ?? null,
    completedAt: plan.generationCompletedAt ?? null,
    elapsedMs,
    completedItems: durations.length,
    averageItemMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    itemsPerMinute: elapsedMs > 0 && durations.length ? Number((durations.length / (elapsedMs / 60000)).toFixed(2)) : null,
    asOf: now,
  };
}


/**
 * Routes keep the pre-beta.3 legacy snapshot columns for historical readers.
 * The execution checkpoint is internal: only its public, version-checked
 * progress view may leave the service boundary.
 */
export function toFeedbackPlanItemView<T extends {
  evidenceSnapshot: string;
  compositionSnapshot: string;
  auditSnapshot: string;
  finalText?: string | null;
  generationConfigSnapshot?: string | null;
  generationExecutionSnapshot?: string | null;
}>(item: T, planType: string) {
  const evidence = FeedbackEvidenceBundleSchema.safeParse(parseJson(item.evidenceSnapshot, null));
  const composition = FeedbackCompositionPlanSchema.safeParse(parseJson(item.compositionSnapshot, null));
  const audit = FeedbackAuditSnapshotSchema.safeParse(parseJson(item.auditSnapshot, null));
  const { generationExecutionSnapshot, ...publicItem } = item;
  return {
    ...publicItem,
    finalText: typeof item.finalText === "string" ? stripFeedbackInternalBoundary(item.finalText) : item.finalText,
    evidence: evidence.success ? sanitizeFeedbackEvidenceBundle(evidence.data) : null,
    composition: composition.success ? sanitizeFeedbackComposition(composition.data) : parseCompositionSnapshot(item.compositionSnapshot, planType, item.finalText ?? ""),
    audit: audit.success ? audit.data : null,
    generationConfig: parseGenerationConfigSnapshot(item.generationConfigSnapshot),
    generationExecution: feedbackGenerationExecutionPublicView(generationExecutionSnapshot ?? null),
  };
}


export function toFeedbackPlanDetail<T extends {
  type: string;
  items: Array<{
    status: string;
    evidenceSnapshot: string;
    compositionSnapshot: string;
    auditSnapshot: string;
    finalText?: string | null;
    generationConfigSnapshot?: string | null;
    generationExecutionSnapshot?: string | null;
    generationDurationMs?: number | null;
  }>;
  generationElapsedMs?: number;
  generationRunStartedAt?: Date | null;
  generationStartedAt?: Date | null;
  generationCompletedAt?: Date | null;
  }>(plan: T) {
  const storedGenerationApproach = normalizeStoredFeedbackGenerationApproach(
    (plan as { generationApproach?: unknown }).generationApproach,
  );
  const legacyReadonly = (plan as { generationApproach?: unknown }).generationApproach === "legacy";
  const itemStatusCounts = generationProgress(plan.items);
  return {
    ...plan,
    generationApproach: storedGenerationApproach === "legacy" ? null : storedGenerationApproach,
    generationApproachLabel: feedbackGenerationApproachLabel(storedGenerationApproach),
    legacyReadonly,
    items: plan.items.map((item) => toFeedbackPlanItemView(item, plan.type)),
    input: FeedbackPlanInputSnapshotSchema.safeParse(parseJson((plan as { inputSnapshot?: string }).inputSnapshot, null)).success
      ? FeedbackPlanInputSnapshotSchema.parse(parseJson((plan as { inputSnapshot?: string }).inputSnapshot, null))
      : null,
    itemStatusCounts,
    actionBucket: feedbackPlanActionBucket((plan as { status?: string }).status ?? "draft", itemStatusCounts),
    generationProgress: itemStatusCounts,
    generationTiming: generationTiming(plan),
  };
}
