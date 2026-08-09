"use client";

import ClassOverviewGrid from "./ClassOverviewGrid";
import { DashboardAttentionPanel, DashboardAttendancePanel, DashboardWarningPanel } from "./DashboardAlerts";
import { ClassDashboardMetrics, StudentDashboardMetrics } from "./DashboardMetrics";
import DashboardTeacherObservations from "./DashboardTeacherObservations";
import TeacherTaskPanel from "./TeacherTaskPanel";
import type { DashboardData } from "./types";

type DashboardViewProps = {
  data: DashboardData;
  semesterId?: string;
};

export function StudentDashboardOverview({ data, semesterId }: DashboardViewProps) {
  const resolvedSemesterId = semesterId ?? data.semester?.id;
  return <div className="dashboard-overview">
    <DashboardWarningPanel semesterId={resolvedSemesterId} studentRisks={data.studentRisks} />
    <TeacherTaskPanel semesterId={resolvedSemesterId} />
    <DashboardAttentionPanel semesterId={resolvedSemesterId} studentRisks={data.studentRisks} />
    <DashboardAttendancePanel semesterId={resolvedSemesterId} attendanceReminders={data.attendanceReminders} />
    <DashboardTeacherObservations semesterId={resolvedSemesterId} />
    <StudentDashboardMetrics data={data} />
  </div>;
}

export function ClassDashboardOverview({ data }: DashboardViewProps) {
  return <div className="dashboard-overview">
    <ClassOverviewGrid classes={data.classOverview} alerts={data.classAlerts} />
    <ClassDashboardMetrics data={data} />
  </div>;
}
