import type { FeedbackAbTestResult, FeedbackAbTestScores, TokenUsage } from "@/services/feedback-ab-test-service";

export type BlindSide = "A" | "B";

export const BLIND_SIDE_LABELS: Record<BlindSide, string> = { A: "方案 A", B: "方案 B" };

export function outputForBlindSide(result: FeedbackAbTestResult, side: BlindSide) {
  const approach = side === "A" ? result.assignment.left : result.assignment.right;
  return approach === "current" ? result.outputs.current : result.outputs.plannerWriter;
}

export function approachForBlindSide(result: FeedbackAbTestResult, side: BlindSide) {
  return side === "A" ? result.assignment.left : result.assignment.right;
}

export function isRatingComplete(scores: FeedbackAbTestScores) {
  return Boolean(
    scores.overall
      && scores.a.modification
      && scores.a.adherence
      && scores.a.aiFlavor >= 1
      && scores.b.modification
      && scores.b.adherence
      && scores.b.aiFlavor >= 1,
  );
}

export function formatTokenValue(value: number | null | undefined) {
  return typeof value === "number" ? value.toLocaleString("zh-CN") : "不可用";
}

export function formatDuration(value: number) {
  return `${value.toLocaleString("zh-CN")} ms`;
}

export function unavailableTokenUsage(): TokenUsage {
  return { inputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null };
}
