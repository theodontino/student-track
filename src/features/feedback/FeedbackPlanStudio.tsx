"use client";

import { FeedbackPlanPanel, type FeedbackPlanPanelProps } from "./FeedbackPlanPanel";

/** Existing plans always enter this surface; plan creation belongs to the task controller. */
export function FeedbackPlanStudio(props: Omit<FeedbackPlanPanelProps, "presentation">) {
  return <FeedbackPlanPanel {...props} presentation="studio" />;
}
