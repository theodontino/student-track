import { z } from "zod";

export const FEEDBACK_GENERATION_APPROACHES = ["restricted", "free"] as const;
export const FeedbackGenerationApproachSchema = z.enum(FEEDBACK_GENERATION_APPROACHES);
export type FeedbackGenerationApproach = z.infer<typeof FeedbackGenerationApproachSchema>;

const STORED_FEEDBACK_GENERATION_APPROACHES = ["legacy", ...FEEDBACK_GENERATION_APPROACHES] as const;
export const StoredFeedbackGenerationApproachSchema = z.enum(STORED_FEEDBACK_GENERATION_APPROACHES);
export type StoredFeedbackGenerationApproach = z.infer<typeof StoredFeedbackGenerationApproachSchema>;

export function normalizeStoredFeedbackGenerationApproach(value: unknown): StoredFeedbackGenerationApproach {
  const parsed = StoredFeedbackGenerationApproachSchema.safeParse(value);
  return parsed.success ? parsed.data : "legacy";
}

export function feedbackGenerationApproachForNewPlan(
  value: unknown,
  fallback: FeedbackGenerationApproach = "restricted",
): FeedbackGenerationApproach {
  const parsed = FeedbackGenerationApproachSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function feedbackGenerationApproachForDerivedPlan(
  storedValue: unknown,
  requestedValue?: unknown,
): FeedbackGenerationApproach {
  const requested = FeedbackGenerationApproachSchema.safeParse(requestedValue);
  if (requested.success) return requested.data;
  const stored = normalizeStoredFeedbackGenerationApproach(storedValue);
  return stored === "legacy" ? "restricted" : stored;
}

export function feedbackGenerationApproachLabel(value: unknown) {
  const approach = normalizeStoredFeedbackGenerationApproach(value);
  if (approach === "restricted") return "受限反馈";
  if (approach === "free") return "自由反馈";
  return "旧生成方式";
}

export const FeedbackGenerationExecutionAttemptV1Schema = z.object({
  attempt: z.number().int().positive(),
  trigger: z.enum(["initial", "retry", "explicit_fallback"]),
  actualApproach: FeedbackGenerationApproachSchema,
  stage: z.enum(["planner", "writer", "free", "deterministic_check"]).optional(),
  status: z.enum(["running", "failed", "succeeded", "interrupted"]),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).optional(),
  error: z.object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
    kind: z.enum(["schema", "timeout", "connection", "aborted", "service"]).optional(),
  }).optional(),
  generationRecordId: z.string().trim().min(1).max(200).optional(),
});
export type FeedbackGenerationExecutionAttemptV1 = z.infer<typeof FeedbackGenerationExecutionAttemptV1Schema>;

export const FeedbackGenerationExecutionSnapshotV1Schema = z.object({
  version: z.literal(1),
  requestedApproach: FeedbackGenerationApproachSchema,
  nextApproach: FeedbackGenerationApproachSchema,
  attempts: z.array(FeedbackGenerationExecutionAttemptV1Schema).max(100),
  restrictedCheckpoint: z.unknown().optional(),
  explicitFallback: z.object({
    from: z.literal("restricted"),
    to: z.literal("free"),
    confirmedAt: z.string().datetime({ offset: true }),
  }).optional(),
});
export type FeedbackGenerationExecutionSnapshotV1 = z.infer<typeof FeedbackGenerationExecutionSnapshotV1Schema>;
export type FeedbackGenerationExecutionPublicV1 = Omit<FeedbackGenerationExecutionSnapshotV1, "restrictedCheckpoint">;

export function createFeedbackGenerationExecutionSnapshot(
  requestedApproach: FeedbackGenerationApproach,
): FeedbackGenerationExecutionSnapshotV1 {
  return {
    version: 1,
    requestedApproach,
    nextApproach: requestedApproach,
    attempts: [],
  };
}

export function parseFeedbackGenerationExecutionSnapshot(
  value: string | unknown,
): FeedbackGenerationExecutionSnapshotV1 | null {
  let candidate = value;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Object.keys(candidate).length === 0) return null;
  const parsed = FeedbackGenerationExecutionSnapshotV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function serializeFeedbackGenerationExecutionSnapshot(
  value: FeedbackGenerationExecutionSnapshotV1,
) {
  return JSON.stringify(FeedbackGenerationExecutionSnapshotV1Schema.parse(value));
}

export function feedbackGenerationExecutionPublicView(
  value: string | unknown,
): FeedbackGenerationExecutionPublicV1 | null {
  const parsed = parseFeedbackGenerationExecutionSnapshot(value);
  if (!parsed) return null;
  const { restrictedCheckpoint: _restrictedCheckpoint, ...publicSnapshot } = parsed;
  void _restrictedCheckpoint;
  return publicSnapshot;
}

export function withExplicitFreeFeedbackFallback(
  value: FeedbackGenerationExecutionSnapshotV1,
  confirmedAt = new Date(),
): FeedbackGenerationExecutionSnapshotV1 {
  if (value.requestedApproach !== "restricted" || value.nextApproach !== "restricted") {
    throw new Error("只有尚未降级的受限反馈可以改用自由反馈");
  }
  return {
    ...value,
    nextApproach: "free",
    restrictedCheckpoint: undefined,
    explicitFallback: {
      from: "restricted",
      to: "free",
      confirmedAt: confirmedAt.toISOString(),
    },
  };
}
