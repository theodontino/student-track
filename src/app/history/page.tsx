import HistoryWorkspace from "@/features/reports/HistoryWorkspace";
import { redirect } from "next/navigation";

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  if (view === "drafts") redirect("/review");
  if (view === "ai") redirect("/system/maintenance");
  return <HistoryWorkspace />;
}
