import { describe, expect, it } from "vitest";
import { DraftReviewResultSchema } from "@/lib/contracts/classroom-parse";

const reviewResult = (revisedScores: Record<string, Record<string, number | null>>) => ({
  is_valid: true,
  issues: [],
  suggestions: [],
  revised_scores: revisedScores,
  revised_events: {},
  revised_teacher_interventions: {},
});

describe("DraftReviewResultSchema", () => {
  it("accepts one decimal for A while keeping B and C integral", () => {
    expect(DraftReviewResultSchema.safeParse(reviewResult({
      合成学生: { A: 4.2, B: 4, C: null },
    })).success).toBe(true);
  });

  it("rejects extra A decimals and fractional B/C revisions", () => {
    expect(DraftReviewResultSchema.safeParse(reviewResult({ 合成学生: { A: 4.25 } })).success).toBe(false);
    expect(DraftReviewResultSchema.safeParse(reviewResult({ 合成学生: { B: 3.5 } })).success).toBe(false);
    expect(DraftReviewResultSchema.safeParse(reviewResult({ 合成学生: { C: 2.5 } })).success).toBe(false);
  });
});
