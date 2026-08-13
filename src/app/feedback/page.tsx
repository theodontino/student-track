import FeedbackWorkspace from "@/features/feedback/FeedbackWorkspace";
import UnifiedFeedbackWorkspace from "@/features/feedback/UnifiedFeedbackWorkspace";
import type { FeedbackStep } from "@/features/feedback/types";

const STEPS: FeedbackStep[] = ["prepare", "extract", "review", "generate", "export"];

export default async function FeedbackPage({ searchParams }: { searchParams: Promise<{ step?: string; advanced?: string; planId?: string }> }) {
  const { step, advanced, planId } = await searchParams;
  // `step=prepare` is a legacy context URL that the old workspace writes while
  // restoring a tab. Keep its semester/class/session context, but show the new
  // default intake flow. Other legacy steps and plan deep links stay available.
  if ((step === undefined || step === "prepare") && advanced !== "1" && !planId) return <UnifiedFeedbackWorkspace />;
  const initialStep = STEPS.includes(step as FeedbackStep) ? step as FeedbackStep : undefined;
  return <FeedbackWorkspace initialStep={initialStep} />;
}
