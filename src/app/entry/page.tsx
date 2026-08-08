import { redirect } from "next/navigation";

export default async function LegacyEntryPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const { step } = await searchParams;
  redirect(step === "review" ? "/review" : "/feedback?step=extract");
}
