import { redirect } from "next/navigation";

export default async function LegacyEntryPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const { step } = await searchParams;
  redirect(`/feedback/tools?tool=manual-facts${step === "review" ? "&step=review" : ""}`);
}
