import FeedbackToolsWorkspace from "@/features/feedback/FeedbackToolsWorkspace";

export default async function FeedbackToolsPage({ searchParams }: { searchParams: Promise<{ tool?: string }> }) {
  const { tool } = await searchParams;
  return <FeedbackToolsWorkspace tool={tool ?? "active-plans"} />;
}
