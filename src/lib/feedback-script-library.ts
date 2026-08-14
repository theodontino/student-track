import type { LessonFeedbackMaterial } from "@/lib/feedback-materials";

export interface FeedbackScriptEntry {
  lessonNumber: number;
  topic: string;
  groupFeedback: string;
  perfectPrivateFeedback: string;
  errorPrivateFeedback: string;
  note: string;
  /** Present in library v2; old v1 entries are normalized on read. */
  material?: LessonFeedbackMaterial;
}

export interface FeedbackScriptLibrary {
  version: 2;
  name: string;
  entries: FeedbackScriptEntry[];
  warnings: string[];
  updatedAt: string;
}

export interface FeedbackScriptLibraryResponse {
  library: FeedbackScriptLibrary | null;
  recommendedLessonNumber: number | null;
}

export function feedbackScriptEntryHasContent(entry: FeedbackScriptEntry) {
  return Boolean(
    entry.groupFeedback.trim()
    || entry.perfectPrivateFeedback.trim()
    || entry.errorPrivateFeedback.trim(),
  );
}
