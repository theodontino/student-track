export interface TeachingContext { semesterId: string; className: string; sessionCode: string; }
export interface SemesterSummary { id: string; name: string; startDate?: string; endDate?: string; sessionCount?: number; }
export interface SessionSummary { id?: string; code: string; date: string; semesterNumber: number; class?: string | null; attendanceCount?: number; }
export interface StudentSummary { id: string; name: string; class: string; }
