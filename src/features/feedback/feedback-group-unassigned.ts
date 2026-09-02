import type { FeedbackGroupIntakeUnassigned } from "@/features/feedback/feedback-task-types";

function isActionableSource(source: FeedbackGroupIntakeUnassigned) {
  return source.kind !== "ignored" && source.blocking !== false;
}

function canBelongToSelectedClass(
  source: FeedbackGroupIntakeUnassigned,
  selectedClassIds: Set<string>,
) {
  const candidateClassIds = source.candidateClassIds?.filter(Boolean) ?? [];
  return candidateClassIds.length === 0
    || candidateClassIds.some((classId) => selectedClassIds.has(classId));
}

/**
 * Limits unresolved group material to the classes in the current round without
 * deleting it from the group draft. A source with no class attribution remains
 * actionable because it could still belong to any selected class.
 */
export function scopeFeedbackGroupUnassignedSources(input: {
  sources: FeedbackGroupIntakeUnassigned[];
  selectedClassIds: Iterable<string>;
  persistedActionableCount: number;
}) {
  const selectedClassIds = new Set(input.selectedClassIds);
  const globallyActionableSources = input.sources.filter(isActionableSource);
  const actionableSources = globallyActionableSources.filter((source) => (
    canBelongToSelectedClass(source, selectedClassIds)
  ));
  const unknownActionableCount = Math.max(
    0,
    input.persistedActionableCount - globallyActionableSources.length,
  );

  return {
    actionableSources,
    actionableCount: unknownActionableCount + actionableSources.length,
  };
}

/**
 * Applies “本轮不采用” only to unresolved material that can affect the selected
 * classes. Material attributed solely to an excluded class stays available for
 * that class's later round.
 */
export function dismissFeedbackGroupUnassignedSourcesForSelectedClasses(input: {
  sources: FeedbackGroupIntakeUnassigned[];
  selectedClassIds: Iterable<string>;
}) {
  const selectedClassIds = new Set(input.selectedClassIds);
  const sources = input.sources.filter((source) => (
    !isActionableSource(source) || !canBelongToSelectedClass(source, selectedClassIds)
  ));
  return {
    sources,
    persistedActionableCount: sources.filter(isActionableSource).length,
  };
}
