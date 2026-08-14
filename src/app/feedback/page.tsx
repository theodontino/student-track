import FeedbackWorkspace from "@/features/feedback/FeedbackWorkspace";
import UnifiedFeedbackWorkspace from "@/features/feedback/UnifiedFeedbackWorkspace";
import type { FeedbackStep } from "@/features/feedback/types";

const STEPS: FeedbackStep[] = ["prepare", "extract", "review", "generate", "export"];

export default async function FeedbackPage({ searchParams }: { searchParams: Promise<{ step?: string; advanced?: string; planId?: string; stage?: string }> }) {
  const { step, advanced, planId, stage } = await searchParams;
  // `step=prepare` is a legacy context URL that the old workspace writes while
  // restoring a tab. Keep its semester/class/session context, but show the new
  // default intake flow. Other legacy steps and plan deep links stay available.
  if ((step === undefined || step === "prepare") && advanced !== "1" && !planId) return <UnifiedFeedbackWorkspace initialStage={stage === "review" ? "review" : "intake"} />;
  if (stage === "studio" && planId && advanced !== "1") return <UnifiedFeedbackWorkspace initialStage="studio" />;
  const initialStep = STEPS.includes(step as FeedbackStep) ? step as FeedbackStep : planId ? "export" : undefined;
  return <FeedbackWorkspace initialStep={initialStep} />;
}
