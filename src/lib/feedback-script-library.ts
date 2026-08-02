export interface FeedbackScriptEntry {
  lessonNumber: number;
  topic: string;
  groupFeedback: string;
  perfectPrivateFeedback: string;
  errorPrivateFeedback: string;
  note: string;
}

export interface FeedbackScriptLibrary {
  version: 1;
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
