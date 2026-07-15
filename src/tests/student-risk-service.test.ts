import { describe, expect, it } from "vitest";
import {
  classifyStudentRisk,
  earlyRelativeStudentIds,
  persistentBelowAverageSignal,
  recentPerformanceDropSignal,
  usesEarlyRelativePerformance,
  type RiskMetricPoint,
} from "@/services/student-risk-service";

function point(composite: number, classAverage: number | null = 3.5, index = 0): RiskMetricPoint {
  return { sessionId: `session-${index}`, composite, classAverage };
}

describe("student risk rules", () => {
  it("switches from early ranking to longitudinal rules after the fourth occurred session", () => {
    expect(usesEarlyRelativePerformance(4)).toBe(true);
    expect(usesEarlyRelativePerformance(5)).toBe(false);
  });

  it("keeps early ranking as one signal bucket and expands boundary ties", () => {
    const ids = earlyRelativeStudentIds([
      { studentId: "a", averageDeviation: -1 },
      { studentId: "b", averageDeviation: -0.5 },
      { studentId: "c", averageDeviation: -0.5 },
      { studentId: "d", averageDeviation: 0.4 },
      { studentId: "e", averageDeviation: 0.6 },
    ]);
    expect(ids).toEqual(new Set(["a", "b", "c"]));
  });

  it("compares the final twenty percent with the student's semester average", () => {
    const dropped = [4, 4, 4, 4, 4, 4, 4, 4, 2.5, 2.5].map((score, index) => point(score, 4, index));
    const recovered = [4, 4, 4, 4, 4, 4, 4, 4, 2.5, 4.5].map((score, index) => point(score, 4, index));
    expect(recentPerformanceDropSignal(dropped)).toMatchObject({
      type: "sustained-decline",
      label: "近期评分回落",
    });
    expect(recentPerformanceDropSignal(dropped)?.evidence).toContain("最近 2/10 次");
    expect(recentPerformanceDropSignal(recovered)).toBeNull();
    expect(recentPerformanceDropSignal([4, 4, 4, 4, 3.43].map((score, index) => point(score, 4, index)))).toBeNull();
    expect(recentPerformanceDropSignal(dropped.slice(0, 4))).toBeNull();
  });

  it("requires coverage, repeated below-average results, and a meaningful average gap", () => {
    const points = [point(2.5, 3.2, 1), point(2.8, 3.4, 2), point(3, 3.7, 3)];
    expect(persistentBelowAverageSignal(points, 5)).toMatchObject({ type: "persistent-below-average" });
    expect(persistentBelowAverageSignal(points.slice(0, 2), 5)).toBeNull();
    expect(persistentBelowAverageSignal([point(3.1, 3.2, 1), point(3.4, 3.5, 2), point(3.5, 3.6, 3)], 5)).toBeNull();
  });

  it("uses signal count for attention and warning regardless of qualitative reason count", () => {
    const qualitative = { type: "qualitative-feedback" as const, label: "定性反馈关注", evidence: "成绩表现、学习信心" };
    const attention = classifyStudentRisk({ studentId: "a", studentName: "测试学生", className: "测试班", signals: [qualitative], qualitativeReasons: ["academic-performance", "learning-confidence"], lastActivityAt: "2026-07-15" });
    const warning = classifyStudentRisk({ studentId: "a", studentName: "测试学生", className: "测试班", signals: [qualitative, { type: "sustained-decline", label: "持续状态回落", evidence: "下降" }], qualitativeReasons: ["academic-performance", "learning-confidence"], lastActivityAt: "2026-07-15" });
    expect(attention?.level).toBe("attention");
    expect(warning?.level).toBe("warning");
  });
});
