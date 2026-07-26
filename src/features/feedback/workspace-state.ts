import { FeedbackWorkspaceSchema } from "@/lib/contracts/feedback";
import type { FeedbackWorkspaceState } from "./types";

export function isFeedbackWorkspace(value: unknown): value is FeedbackWorkspaceState {
  return FeedbackWorkspaceSchema.safeParse(value).success;
}

export function todayLocalDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
