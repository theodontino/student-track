"use client";

import { useRouter } from "next/navigation";
import { Badge, EmptyState, Section, StatusBanner, StatusDot } from "@/components/ui";
import type { AttendanceReminder, StudentRisk } from "./types";

function RiskRows({ risks, semesterId, compact = false }: { risks: StudentRisk[]; semesterId?: string; compact?: boolean }) {
  const router = useRouter();
  return <div className={`dashboard-alert-list${compact ? " dashboard-alert-list--compact" : ""}`}>{risks.map((risk) => (
    <button
      type="button"
      key={risk.studentId}
      className="dashboard-alert-row dashboard-alert-row--button"
      onClick={() => router.push(`/students/${risk.studentId}${semesterId ? `?semesterId=${encodeURIComponent(semesterId)}` : ""}`)}
    >
      <StatusDot tone={risk.level === "warning" ? "danger" : "info"} label={risk.level === "warning" ? "警告" : "关注"} />
      <div>
        <strong>{risk.studentName}<span>{risk.className} · {risk.signals.length} 项条件</span></strong>
        <div className="dashboard-risk-signals">{risk.signals.map((signal) => <div key={signal.type}><Badge tone={signal.type === "qualitative-feedback" ? "info" : risk.level === "warning" ? "danger" : "warning"}>{signal.label}</Badge><p>{signal.evidence}</p></div>)}</div>
      </div>
      <span className="dashboard-alert-row__action">查看档案 →</span>
    </button>
  ))}</div>;
}

const ATTENTION_GROUPS = [
  {
    id: "trend",
    title: "状态回落",
    description: "近三次有效表现持续下降",
    accepts: (risk: StudentRisk) => risk.signals[0]?.type === "sustained-decline",
  },
  {
    id: "performance",
    title: "表现观察",
    description: "早期相对靠后或长期低于班均",
    accepts: (risk: StudentRisk) => risk.signals[0]?.type === "early-relative-performance" || risk.signals[0]?.type === "persistent-below-average",
  },
  {
    id: "qualitative",
    title: "定性反馈",
    description: "成绩、信心、家长担心或退班意向",
    accepts: (risk: StudentRisk) => risk.signals[0]?.type === "qualitative-feedback",
  },
] as const;

function AttentionColumns({ risks, semesterId }: { risks: StudentRisk[]; semesterId?: string }) {
  return <div className="dashboard-attention-grid">{ATTENTION_GROUPS.map((group) => {
    const groupedRisks = risks.filter(group.accepts);
    return <section key={group.id} className={`dashboard-attention-column dashboard-attention-column--${group.id}`} aria-labelledby={`attention-group-${group.id}`}>
      <header>
        <div><h3 id={`attention-group-${group.id}`}>{group.title}</h3><p>{group.description}</p></div>
        <Badge tone={groupedRisks.length > 0 ? "info" : "neutral"}>{groupedRisks.length} 人</Badge>
      </header>
      {groupedRisks.length > 0
        ? <RiskRows risks={groupedRisks} semesterId={semesterId} compact />
        : <p className="dashboard-attention-column__empty">暂无此类关注学生</p>}
    </section>;
  })}</div>;
}

function AttendanceRows({ reminders, semesterId }: { reminders: AttendanceReminder[]; semesterId?: string }) {
  const router = useRouter();
  return <div className="dashboard-alert-list">{reminders.map((reminder) => <button type="button" key={reminder.studentId} className="dashboard-alert-row dashboard-alert-row--button" onClick={() => router.push(`/students/${reminder.studentId}${semesterId ? `?semesterId=${encodeURIComponent(semesterId)}` : ""}`)}><StatusDot tone={reminder.level === "warning" ? "danger" : "warning"} label={reminder.level === "warning" ? "考勤警告" : "考勤关注"} /><div><strong>{reminder.studentName}<span>{reminder.className}</span></strong><p>本学期累计缺勤 {reminder.absenceCount} 次；考勤提醒不参与学习状态风险叠加。</p></div><span className="dashboard-alert-row__action">查看档案 →</span></button>)}</div>;
}

export default function DashboardAlerts({ semesterId, totalStudents, studentRisks, attendanceReminders }: { semesterId?: string; totalStudents: number; studentRisks: StudentRisk[]; attendanceReminders: AttendanceReminder[] }) {
  const warnings = studentRisks.filter((risk) => risk.level === "warning");
  const attention = studentRisks.filter((risk) => risk.level === "attention");

  if (totalStudents === 0) return <Section title="学生状态"><EmptyState title="暂无学生状态记录" description="完成本学期课次录入后，这里会显示关注、警告和考勤提醒。" /></Section>;

  return <div className="dashboard-risk-layout">
    <div className="dashboard-alerts">
      <Section className="dashboard-risk-section dashboard-risk-section--warning" title="警告——需要优先处理" description="同时命中至少两项独立条件" actions={<Badge tone={warnings.length > 0 ? "danger" : "neutral"}>{warnings.length} 人</Badge>}>
        {warnings.length > 0 ? <RiskRows risks={warnings} semesterId={semesterId} /> : <div className="p-4"><StatusBanner tone="success">当前没有需要优先处理的警告学生。</StatusBanner></div>}
      </Section>
      <Section className="dashboard-risk-section dashboard-risk-section--attention" title="持续关注" description="按触发原因分为状态回落、表现观察和定性反馈" actions={<Badge tone={attention.length > 0 ? "info" : "neutral"}>{attention.length} 人</Badge>}>
        {attention.length > 0 ? <AttentionColumns risks={attention} semesterId={semesterId} /> : <div className="p-4"><StatusBanner tone="success">当前没有需要持续关注的学生。</StatusBanner></div>}
      </Section>
    </div>
    <Section className="dashboard-risk-section dashboard-risk-section--attendance" title="考勤提醒" description="独立于学习状态风险，不参与关注和警告叠加" actions={<Badge tone={attendanceReminders.some((item) => item.level === "warning") ? "danger" : attendanceReminders.length > 0 ? "warning" : "neutral"}>{attendanceReminders.length} 人</Badge>}>
      {attendanceReminders.length > 0 ? <AttendanceRows reminders={attendanceReminders} semesterId={semesterId} /> : <div className="p-4"><StatusBanner tone="success">本学期没有触发考勤提醒。</StatusBanner></div>}
    </Section>
  </div>;
}
