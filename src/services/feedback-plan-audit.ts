import { createHash } from "node:crypto";
import {
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
