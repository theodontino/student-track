"use client";

import { useEffect } from "react";
import type { FeedbackTaskDraftV2 } from "./feedback-task-state";

const KEY = "student-track:feedback-task-draft:v2";

export function readFeedbackTaskDraft(): FeedbackTaskDraftV2 | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as FeedbackTaskDraftV2 | null;
    return value?.version === 2 && Array.isArray(value.entries) ? value : null;
  } catch { return null; }
}

export function clearFeedbackTaskDraft() { sessionStorage.removeItem(KEY); }

export function useFeedbackTaskDraftPersistence(draft: FeedbackTaskDraftV2, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const save = () => sessionStorage.setItem(KEY, JSON.stringify(draft));
    const timer = window.setTimeout(save, 300);
    window.addEventListener("pagehide", save);
    return () => { window.clearTimeout(timer); window.removeEventListener("pagehide", save); };
  }, [draft, enabled]);
}
