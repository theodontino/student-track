export interface TeachingContext { semesterId: string; className: string; classId?: string; sessionCode: string; }
export interface SemesterSummary { id: string; name: string; startDate?: string; endDate?: string; sessionCount?: number; }
export interface SessionSummary { id?: string; code: string; date: string; semesterNumber: number; class?: string | null; attendanceCount?: number; }
export interface StudentSummary { id: string; name: string; class: string; }
export interface ClassSummary {
  id: string;
  code: string;
  name: string | null;
  semesterId: string;
  activeStudentCount?: number;
  inactiveStudentCount?: number;
  sessionCount?: number;
}
