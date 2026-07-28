import HistoryWorkspace from "@/features/reports/HistoryWorkspace";

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  return <HistoryWorkspace initialView={view === "drafts" || view === "ai" ? view : "history"} />;
}
