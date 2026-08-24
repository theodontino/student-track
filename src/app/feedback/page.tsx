import { redirect } from "next/navigation";
import FeedbackTaskWorkspace from "@/features/feedback/FeedbackTaskWorkspace";

export default async function FeedbackPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  if (!params.planId && params.step === "extract") redirect("/feedback/tools?tool=manual-facts");
  if (!params.planId && params.step === "review") redirect("/feedback/tools?tool=fact-editor");
  if (!params.planId && (params.step === "generate" || params.step === "export")) redirect("/feedback/tools?tool=plan-builder");
  return <FeedbackTaskWorkspace />;
}
