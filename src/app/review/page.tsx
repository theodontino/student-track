"use client";

import { useAiWorkflow } from "@/features/ai-workflow";
import ReviewStep from "@/features/entry/ReviewStep";

export default function ReviewPage() {
  const workflow = useAiWorkflow();
  return <main className="entry-review-page"><ReviewStep workflow={workflow} /></main>;
}
