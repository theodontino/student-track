import FeedbackWorkspace from "@/features/feedback/FeedbackWorkspace";
import type { FeedbackStep } from "@/features/feedback/types";

const STEPS: FeedbackStep[] = ["prepare", "extract", "review", "generate", "export"];

export default async function AdvancedFeedbackPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const { step } = await searchParams;
  const initialStep = STEPS.includes(step as FeedbackStep) ? step as FeedbackStep : undefined;
  return <FeedbackWorkspace initialStep={initialStep} />;
}
