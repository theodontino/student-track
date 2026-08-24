import { redirect } from "next/navigation";

export default async function AdvancedFeedbackPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const values = await searchParams;
  if (values.planId) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
    redirect(`/feedback?${query}`);
  }
  const tool = values.step === "extract" ? "manual-facts" : values.step === "review" ? "fact-editor" : values.step === "generate" || values.step === "export" ? "plan-builder" : "active-plans";
  redirect(`/feedback/tools?tool=${tool}`);
}
