export interface FeedbackContextPreview {
  today: string[];
  trend: string;
  communications: string[];
  labels: string[];
}

export interface FeedbackContextStudent {
  id: string;
  name: string;
  studentId: string;
  labels: string[];
  preview: FeedbackContextPreview;
  feedbackRecommendationReasons?: string[];
}
