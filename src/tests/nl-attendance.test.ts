import { describe, expect, it } from "vitest";
import { completeClassAttendance } from "@/lib/nlAttendance";

describe("completeClassAttendance", () => {
  it("marks mentioned students present and every omitted roster student absent", () => {
    const result = completeClassAttendance({
      students: [{
        name: "张三",
        scores: { A: 5, B: null, C: null },
        events: ["测验全对"],
        communication: null,
      }],
      alert_suggestion: "",
    }, [
      { id: "1", name: "张三" },
      { id: "2", name: "李四" },
    ]);

    expect(result.students).toEqual([
      expect.objectContaining({ name: "张三", present: true }),
      {
        name: "李四",
        scores: { A: null, B: null, C: null },
        events: [],
        communication: null,
        present: false,
      },
    ]);
  });

  it("deduplicates LLM output by roster name", () => {
    const result = completeClassAttendance({
      students: [
        { name: "张三", scores: { A: 4, B: null, C: null }, events: [], communication: null },
        { name: "张三", scores: { A: 2, B: null, C: null }, events: [], communication: null },
      ],
      alert_suggestion: "",
    }, [{ id: "1", name: "张三" }]);
    expect(result.students).toHaveLength(1);
    expect(result.students[0].scores.A).toBe(4);
  });
});
