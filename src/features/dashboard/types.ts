export interface ClassOverview {
  name: string;
  avgA: number;
  avgB: number;
  avgC: number;
  avgD: number;
  studentCount: number;
  lastActivityAt: string;
}

export interface ClassAlert {
  className: string;
  dimension: string;
  avgScore: number;
  severity: "red" | "yellow";
}

import type { AttentionReason } from "@/lib/attention-labels";

export interface StudentAlert {
  studentId: string;
  studentName: string;
  class: string;
  dimension: string;
  score: number;
  classAvg: number;
  deviation: number;
  severity: "red" | "yellow";
  lastActivityAt: string;
}

export interface StudentRisk {
  studentId: string;
  studentName: string;
  className: string;
  level: "attention" | "warning";
  signals: Array<{
    type: "early-relative-performance" | "sustained-decline" | "persistent-below-average" | "qualitative-feedback";
    label: string;
    evidence: string;
  }>;
  qualitativeReasons: AttentionReason[];
  lastActivityAt: string;
}

export interface AttendanceReminder {
  studentId: string;
  studentName: string;
  className: string;
  absenceCount: number;
  level: "attention" | "warning";
}

export interface DashboardData {
  semester: { id: string; name: string; startDate: string; endDate: string } | null;
  classOverview: ClassOverview[];
  classAlerts: ClassAlert[];
  studentAlerts: StudentAlert[];
  studentRisks: StudentRisk[];
  attendanceReminders: AttendanceReminder[];
  totalStudents: number;
  redCount: number;
  yellowCount: number;
  warningCount: number;
  attentionCount: number;
}
