export const FEEDBACK_INTENSITIES = ["routine", "attention", "priority", "manual"] as const;

export type FeedbackIntensity = typeof FEEDBACK_INTENSITIES[number];
export type AutomaticFeedbackIntensity = Exclude<FeedbackIntensity, "manual">;

export type FeedbackRoutingReason =
  | "dashboard-warning"
  | "dashboard-attention"
  | "recent-teacher-observation";

export interface FeedbackRoutingDecision {
  studentId: string;
  baseline: AutomaticFeedbackIntensity;
  intensity: FeedbackIntensity;
  reasons: FeedbackRoutingReason[];
}

export const FEEDBACK_INTENSITY_LABELS: Record<FeedbackIntensity, string> = {
  routine: "常规",
  attention: "轻关注",
  priority: "重点关注",
  manual: "人工确认",
};

export const FEEDBACK_ROUTING_REASON_LABELS: Record<FeedbackRoutingReason, string> = {
  "dashboard-warning": "学习风险警告",
  "dashboard-attention": "学习风险关注",
  "recent-teacher-observation": "近期教学观察",
};
