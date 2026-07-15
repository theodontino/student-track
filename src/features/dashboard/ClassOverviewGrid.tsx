import { Badge, EmptyState, Section } from "@/components/ui";
import type { ClassAlert, ClassOverview } from "./types";

const dimensions: Array<{ label: string; key: "avgA" | "avgB" | "avgC" | "avgD"; color: string }> = [
  { label: "学习&测验", key: "avgA", color: "dashboard-progress--a" },
  { label: "精神&纪律", key: "avgB", color: "dashboard-progress--b" },
  { label: "课后任务", key: "avgC", color: "dashboard-progress--c" },
  { label: "考勤", key: "avgD", color: "dashboard-progress--d" },
];

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

export default function ClassOverviewGrid({ classes, alerts }: { classes: ClassOverview[]; alerts: ClassAlert[] }) {
  const alertMap = new Map<string, ClassAlert[]>();
  for (const alert of alerts) alertMap.set(alert.className, [...(alertMap.get(alert.className) ?? []), alert]);

  return <Section title="班级状态" description="四维数据取各学生最近一条本学期评价；班级阈值不计入学生关注或警告人数">
    {classes.length === 0 ? <EmptyState title="暂无班级状态记录" description="录入评价后会显示班级四维概况。" /> : <div className="dashboard-class-grid">{classes.map((item) => {
      const classAlerts = alertMap.get(item.name) ?? [];
      const tone = classAlerts.some((alert) => alert.severity === "red") ? "danger" : classAlerts.length > 0 ? "warning" : "neutral";
      return <article key={item.name} className="dashboard-class-card"><header><div><h3>{item.name}</h3><p>{item.studentCount} 名学生 · 最近记录 {dateLabel(item.lastActivityAt)}</p></div>{classAlerts.length > 0 && <Badge tone={tone}>{classAlerts.length} 项预警</Badge>}</header><div className="dashboard-dimensions">{dimensions.map((dimension) => {
        const value = item[dimension.key];
        const alert = classAlerts.find((candidate) => candidate.dimension === dimension.label);
        return <div key={dimension.key} className="dashboard-dimension"><span>{dimension.label}</span><div className="dashboard-progress" role="progressbar" aria-label={`${item.name}${dimension.label}平均分`} aria-valuemin={0} aria-valuemax={5} aria-valuenow={value}><span className={dimension.color} style={{ width: `${Math.max(0, Math.min(100, value / 5 * 100))}%` }} /></div><strong className={alert ? `is-${alert.severity}` : ""}>{value}</strong></div>;
      })}</div></article>;
    })}</div>}
  </Section>;
}
