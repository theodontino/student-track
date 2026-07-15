"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, EmptyState, Section, StatusBanner, StatusDot } from "@/components/ui";
import type { AttendanceReminder, StudentRisk } from "./types";

function RiskRows({ risks, semesterId }: { risks: StudentRisk[]; semesterId?: string }) {
  const router = useRouter();
  return <div className="dashboard-alert-list">{risks.map((risk) => (
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

function AttendanceRows({ reminders, semesterId }: { reminders: AttendanceReminder[]; semesterId?: string }) {
  const router = useRouter();
  return <div className="dashboard-alert-list">{reminders.map((reminder) => <button type="button" key={reminder.studentId} className="dashboard-alert-row dashboard-alert-row--button" onClick={() => router.push(`/students/${reminder.studentId}${semesterId ? `?semesterId=${encodeURIComponent(semesterId)}` : ""}`)}><StatusDot tone={reminder.level === "warning" ? "danger" : "warning"} label={reminder.level === "warning" ? "考勤警告" : "考勤关注"} /><div><strong>{reminder.studentName}<span>{reminder.className}</span></strong><p>本学期累计缺勤 {reminder.absenceCount} 次；考勤提醒不参与学习状态风险叠加。</p></div><span className="dashboard-alert-row__action">查看档案 →</span></button>)}</div>;
}

export default function DashboardAlerts({ semesterId, totalStudents, studentRisks, attendanceReminders }: { semesterId?: string; totalStudents: number; studentRisks: StudentRisk[]; attendanceReminders: AttendanceReminder[] }) {
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  const warnings = studentRisks.filter((risk) => risk.level === "warning");
  const attention = studentRisks.filter((risk) => risk.level === "attention");
  const visibleAttention = attentionExpanded ? attention : attention.slice(0, 5);

  if (totalStudents === 0) return <Section title="学生状态"><EmptyState title="暂无学生状态记录" description="完成本学期课次录入后，这里会显示关注、警告和考勤提醒。" /></Section>;

  return <div className="dashboard-risk-layout">
    <div className="dashboard-alerts">
      <Section className="dashboard-risk-section dashboard-risk-section--warning" title="警告——需要优先处理" description="同时命中至少两项独立条件" actions={<Badge tone={warnings.length > 0 ? "danger" : "neutral"}>{warnings.length} 人</Badge>}>
        {warnings.length > 0 ? <RiskRows risks={warnings} semesterId={semesterId} /> : <div className="p-4"><StatusBanner tone="success">当前没有需要优先处理的警告学生。</StatusBanner></div>}
      </Section>
      <Section className="dashboard-risk-section dashboard-risk-section--attention" title="持续关注" description="命中一项数字或定性反馈条件" actions={<Badge tone={attention.length > 0 ? "info" : "neutral"}>{attention.length} 人</Badge>}>
        {attention.length > 0 ? <><RiskRows risks={visibleAttention} semesterId={semesterId} />{attention.length > 5 && <div className="dashboard-alert-footer"><button type="button" onClick={() => setAttentionExpanded((current) => !current)}>{attentionExpanded ? "收起关注名单" : `展开其余 ${attention.length - 5} 人`}</button></div>}</> : <div className="p-4"><StatusBanner tone="success">当前没有需要持续关注的学生。</StatusBanner></div>}
      </Section>
    </div>
    <Section className="dashboard-risk-section dashboard-risk-section--attendance" title="考勤提醒" description="独立于学习状态风险，不参与关注和警告叠加" actions={<Badge tone={attendanceReminders.some((item) => item.level === "warning") ? "danger" : attendanceReminders.length > 0 ? "warning" : "neutral"}>{attendanceReminders.length} 人</Badge>}>
      {attendanceReminders.length > 0 ? <AttendanceRows reminders={attendanceReminders} semesterId={semesterId} /> : <div className="p-4"><StatusBanner tone="success">本学期没有触发考勤提醒。</StatusBanner></div>}
    </Section>
  </div>;
}
