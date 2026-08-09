import { MetricCard } from "@/components/ui";
import type { DashboardData } from "./types";

export function StudentDashboardMetrics({ data }: { data: DashboardData }) {
  return <div className="dashboard-metrics">
    <MetricCard label="本学期学生" value={data.totalStudents} detail="有本学期教学记录" tone="brand" />
    <MetricCard label="警告学生" value={data.warningCount} detail={data.warningCount > 0 ? "命中至少两项独立条件" : "当前没有警告学生"} tone={data.warningCount > 0 ? "danger" : "neutral"} />
    <MetricCard label="关注学生" value={data.attentionCount} detail={data.attentionCount > 0 ? "命中一项关注条件" : "当前没有关注学生"} tone={data.attentionCount > 0 ? "warning" : "neutral"} />
  </div>;
}

export function ClassDashboardMetrics({ data }: { data: DashboardData }) {
  const alertClassCount = new Set(data.classAlerts.map((alert) => alert.classId)).size;
  return <div className="dashboard-metrics">
    <MetricCard label="本学期班级" value={data.classOverview.length} detail="按最近参与课次归属" tone="brand" />
    <MetricCard label="预警班级" value={alertClassCount} detail={alertClassCount > 0 ? "至少一个维度低于班级阈值" : "当前没有预警班级"} tone={alertClassCount > 0 ? "danger" : "neutral"} />
    <MetricCard label="预警维度" value={data.classAlerts.length} detail={data.classAlerts.length > 0 ? "需要教师查看班级四维概况" : "当前没有预警维度"} tone={data.classAlerts.length > 0 ? "warning" : "neutral"} />
  </div>;
}
