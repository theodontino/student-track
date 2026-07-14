import { describe, expect, it } from "vitest";
import { formatLogDetail } from "@/features/system/maintenance-types";

describe("system maintenance formatting", () => {
  it("renders empty and structured log details", () => {
    expect(formatLogDetail({})).toBe("—");
    expect(formatLogDetail({ studentId: "S001", change: { score: 4 } })).toBe('studentId: S001 | change: {"score":4}');
  });
});
