import type { StudentSemesterSummary } from "@/services/student-semester-summary-service";
import type { StudentListItem } from "./types";

export function filterStudents(students: StudentListItem[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return students;
  return students.filter((student) => (
    student.name.toLowerCase().includes(query)
    || student.studentId.toLowerCase().includes(query)
    || student.labels.some((label) => label.name.toLowerCase().includes(query))
    || student.class.toLowerCase().includes(query)
  ));
}

export function groupStudentsByClass(students: StudentListItem[]) {
  const groups = new Map<string, StudentListItem[]>();
  for (const student of students) {
    const group = groups.get(student.class) ?? [];
    group.push(student);
    groups.set(student.class, group);
  }
  return groups;
}

export function studentSummaryHint(summary: StudentSemesterSummary | null | undefined) {
  if (!summary || (summary.ratedSessionCount === 0 && summary.attendanceRecordedCount === 0)) return "暂无评价与考勤";
  if (summary.ratedSessionCount === 0) return "缺少课次评价";
  if (summary.attendanceRecordedCount === 0) return "缺少考勤记录";
  return `评价 ${summary.ratedSessionCount} 次 · 考勤 ${summary.attendanceRecordedCount} 次`;
}
