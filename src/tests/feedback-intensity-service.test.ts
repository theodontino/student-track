import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dashboard: vi.fn(),
  observations: vi.fn(),
}));

vi.mock("@/services/alert-service", () => ({ getAlertDashboard: mocks.dashboard }));
vi.mock("@/services/teacher-observation-service", () => ({ listTeacherObservations: mocks.observations }));

import { buildFeedbackRouting } from "@/services/feedback-intensity-service";

const context = {
  session: { semesterId: "semester-1", date: "2026-07-20" },
  students: [{ id: "routine" }, { id: "attention" }, { id: "warning" }, { id: "both" }],
} as any;

describe("feedback intensity routing", () => {
  it("uses dashboard risk and recent active observations, never attendance", async () => {
    mocks.dashboard.mockResolvedValue({
      studentRisks: [
        { studentId: "attention", level: "attention" },
        { studentId: "warning", level: "warning" },
        { studentId: "both", level: "attention" },
      ],
      attendanceReminders: [{ studentId: "routine", level: "warning" }],
    });
    mocks.observations.mockResolvedValue([
      { student: { id: "both" }, sources: [{ occurredAt: "2026-07-20" }] },
      { student: { id: "routine" }, sources: [{ occurredAt: "2026-06-28" }] },
    ]);
    const routing = await buildFeedbackRouting({} as any, context);
    expect(routing).toEqual([
      { studentId: "routine", baseline: "routine", intensity: "routine", reasons: [] },
      { studentId: "attention", baseline: "attention", intensity: "attention", reasons: ["dashboard-attention"] },
      { studentId: "warning", baseline: "priority", intensity: "priority", reasons: ["dashboard-warning"] },
      { studentId: "both", baseline: "priority", intensity: "priority", reasons: ["dashboard-attention", "recent-teacher-observation"] },
    ]);
  });
});
