"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import ClassOverviewGrid from "./ClassOverviewGrid";
import DashboardAlerts from "./DashboardAlerts";
import DashboardMetrics from "./DashboardMetrics";
import type { DashboardData } from "./types";

export default function DashboardOverview({ data, showFeedbackShortcut = false }: { data: DashboardData; showFeedbackShortcut?: boolean }) {
  const router = useRouter();
  const feedbackUrl = data.semester ? `/feedback?semesterId=${encodeURIComponent(data.semester.id)}` : "/feedback";

  return <div className="dashboard-overview">
    <DashboardMetrics data={data} />
    {showFeedbackShortcut && <section className="dashboard-shortcut"><div><span>课堂记录 → 人工复核 → 家校反馈</span><h2>继续完成课后反馈</h2><p>沿用当前学期，选择班级和课次后生成可编辑反馈。</p></div><Button onClick={() => router.push(feedbackUrl)}>进入反馈工作台</Button></section>}
    <DashboardAlerts semesterId={data.semester?.id} totalStudents={data.totalStudents} studentRisks={data.studentRisks} attendanceReminders={data.attendanceReminders} />
    <ClassOverviewGrid classes={data.classOverview} alerts={data.classAlerts} />
  </div>;
}
