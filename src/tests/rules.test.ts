import { describe, expect, it } from "vitest";
import {
  calculateAttendanceScore,
  calculateStudentAlertCutoffs,
  evaluateAbsenceAlert,
  evaluateClassAverageAlert,
  normalizeDimensionScore,
} from "@/config/rules";

describe("business rules", () => {
  it("normalizes scores to configured integer bounds", () => {
    expect(normalizeDimensionScore(-2)).toBe(0);
    expect(normalizeDimensionScore(2.6)).toBe(3);
    expect(normalizeDimensionScore(8)).toBe(5);
    expect(normalizeDimensionScore("invalid")).toBeNull();
  });

  it("calculates attendance D score including the empty-semester fallback", () => {
    expect(calculateAttendanceScore(0, 0)).toBe(3);
    expect(calculateAttendanceScore(3, 4)).toBe(4);
    expect(calculateAttendanceScore(4, 4)).toBe(5);
  });

  it("evaluates class and absence thresholds at their boundaries", () => {
    expect(evaluateClassAverageAlert(2.49)).toBe("red");
    expect(evaluateClassAverageAlert(2.5)).toBe("yellow");
    expect(evaluateClassAverageAlert(3)).toBeNull();
    expect(evaluateAbsenceAlert(1)).toBeNull();
    expect(evaluateAbsenceAlert(2)).toBe("yellow");
    expect(evaluateAbsenceAlert(4)).toBe("red");
  });

  it("calculates minimum ranking buckets for small and larger classes", () => {
    expect(calculateStudentAlertCutoffs(3)).toEqual({ red: 1, yellow: 2 });
    expect(calculateStudentAlertCutoffs(20)).toEqual({ red: 2, yellow: 4 });
  });
});
