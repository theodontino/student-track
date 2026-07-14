import { describe, expect, it } from "vitest";
import { filterStudents, groupStudentsByClass, studentSummaryHint } from "@/features/students/student-list-utils";
import type { StudentListItem } from "@/features/students/types";

const students = [
  { id: "1", name: "测试甲", class: "一班", classCode: "C1", studentId: "S001", gender: "男", labels: [{ id: "l1", name: "#主动" }], createdAt: "", updatedAt: "" },
  { id: "2", name: "测试乙", class: "二班", classCode: "C2", studentId: "S002", gender: "女", labels: [], createdAt: "", updatedAt: "" },
] satisfies StudentListItem[];

describe("student list utilities", () => {
  it("filters by name, student number, label, and class", () => {
    expect(filterStudents(students, "甲")).toHaveLength(1);
    expect(filterStudents(students, "s002")[0].id).toBe("2");
    expect(filterStudents(students, "主动")[0].id).toBe("1");
    expect(filterStudents(students, "二班")[0].id).toBe("2");
  });

  it("groups students by their displayed class", () => {
    const groups = groupStudentsByClass(students);
    expect(groups.get("一班")?.map((student) => student.id)).toEqual(["1"]);
    expect(groups.get("二班")?.map((student) => student.id)).toEqual(["2"]);
  });

  it("explains incomplete semester scores", () => {
    expect(studentSummaryHint(null)).toBe("暂无评价与考勤");
    expect(studentSummaryHint({ ratedSessionCount: 0, attendanceRecordedCount: 2 } as never)).toBe("缺少课次评价");
    expect(studentSummaryHint({ ratedSessionCount: 2, attendanceRecordedCount: 0 } as never)).toBe("缺少考勤记录");
  });
});
