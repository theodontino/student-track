import { redirect } from "next/navigation";
export default async function PastOverviewPage({ searchParams }: { searchParams: Promise<{ semesterId?: string }> }) { const { semesterId } = await searchParams; redirect(semesterId ? `/?semesterId=${encodeURIComponent(semesterId)}` : "/"); }
