"use client";

import type { StudentSemesterSummary } from "@/services/student-semester-summary-service";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";

function scoreText(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toFixed(1);
}

function missingSummaryReason(summary: StudentSemesterSummary | null) {
  if (!summary) return "当前没有可用学期。";
  if (summary.ratedSessionCount === 0 && summary.attendanceRecordedCount === 0) return "本学期暂无课次评价和考勤记录。";
  if (summary.ratedSessionCount === 0) return "本学期缺少课次评价，暂不能生成综合分。";
  if (summary.attendanceRecordedCount === 0) return "本学期缺少考勤记录，暂不能生成综合分。";
  return "数据不足，暂不能生成综合分。";
}

export function StudentPerformanceOverview({ summary }: { summary: StudentSemesterSummary | null }) {
  const hasRadarData = Boolean(summary && (summary.ratedSessionCount > 0 || summary.attendanceScore !== null));
  const radarData = summary ? [
    { dim: "学习&测验", score: summary.averageA ?? undefined },
    { dim: "精神&纪律", score: summary.averageB ?? undefined },
    { dim: "课后任务", score: summary.averageC ?? undefined },
    { dim: "考勤", score: summary.attendanceScore ?? undefined },
  ] : [];

  return (
    <div className="student-performance-grid">
      <section data-testid="student-semester-radar" className="student-chart-card">
        <header>
          <div>
            <h2>本学期四维平均表现</h2>
            <p>A/B/C 为课次评价平均分，D 为本学期已录考勤分。</p>
          </div>
        </header>
        {hasRadarData ? (
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={radarData}>
              <PolarGrid stroke="var(--color-border)" />
              <PolarAngleAxis dataKey="dim" fontSize={12} />
              <PolarRadiusAxis angle={30} domain={[0, 5]} tickCount={6} fontSize={11} />
              <Radar name="学期表现" dataKey="score" stroke="var(--chart-a)" fill="var(--chart-a)" fillOpacity={0.18} />
            </RadarChart>
          </ResponsiveContainer>
        ) : (
          <div className="student-chart-empty">本学期暂无评价和考勤数据</div>
        )}
      </section>

      <section data-testid="student-semester-summary" className="student-score-card">
        <div>
          <p className="student-score-card__eyebrow">本学期综合分</p>
          <p className="student-score-card__semester">{summary?.semester.name ?? "暂无可用学期"}</p>
        </div>
        <div className="student-score-card__total">
          <strong>{summary?.score100 ?? "—"}</strong>
          {summary?.score100 !== null && summary?.score100 !== undefined && <span>/100</span>}
        </div>
        <p className="student-score-card__reason">
          {summary?.total20 !== null && summary?.total20 !== undefined ? `${summary.total20.toFixed(1)} / 20` : missingSummaryReason(summary)}
        </p>
        <div className="student-score-card__dimensions">
          {(["A", "B", "C", "D"] as const).map((label, index) => {
            const value = [summary?.averageA, summary?.averageB, summary?.averageC, summary?.attendanceScore][index];
            return <div key={label}><span>{label}</span><strong>{scoreText(value)}</strong></div>;
          })}
        </div>
        <dl className="student-score-card__facts">
          <div><dt>课次评价</dt><dd>{summary?.ratedSessionCount ?? 0} 次</dd></div>
          <div><dt>考勤记录</dt><dd>{summary?.attendanceRecordedCount ?? 0} 次</dd></div>
          <div><dt>实际出勤</dt><dd>{summary?.presentCount ?? 0} 次</dd></div>
        </dl>
      </section>
    </div>
  );
}
