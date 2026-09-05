import { createHash } from "node:crypto";
import {
  RESTRICTED_WRITER_OUTPUT_INVALID_CODE,
  validateCompositionForBundle,
  type FeedbackAuditSnapshot,
  type FeedbackCompositionPlan,
  type FeedbackEvidenceBundle,
  type FeedbackGenerationPreferences,
} from "@/lib/feedback-plan";

export function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createAuditSnapshot(
  composition: FeedbackCompositionPlan,
  bundle: FeedbackEvidenceBundle,
  taskIds?: Set<string>,
  identity?: { studentName?: string; otherStudentNames?: string[] },
  options?: { enforceParentAudience?: boolean; generationPreferences?: FeedbackGenerationPreferences },
): FeedbackAuditSnapshot {
  const result = validateCompositionForBundle(composition, bundle, taskIds, identity, options);
  return {
    version: 1,
    status: result.status,
    items: result.issues,
    textHash: sha256(composition.draftFeedback),
    semanticReviewRequired: result.status !== "pass",
  };
}

export function blockAuditForRestrictedWriter(
  audit: FeedbackAuditSnapshot,
  message: string,
): FeedbackAuditSnapshot {
  return {
    ...audit,
    status: "blocked",
    items: [
      ...audit.items.filter((issue) => issue.code !== RESTRICTED_WRITER_OUTPUT_INVALID_CODE),
      {
        code: RESTRICTED_WRITER_OUTPUT_INVALID_CODE,
        severity: "blocked",
        message: message.trim().slice(0, 1000) || "受限 Writer 草稿未通过程序核验",
      },
    ],
    semanticReviewRequired: true,
  };
}
