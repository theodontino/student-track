"use client";

import { useState } from "react";
import { Select } from "@/components/ui";
import type { StudentDetail } from "./types";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function StudentTrendChart({ metrics }: { metrics: StudentDetail["sessionMetrics"] }) {
  const [trendDays, setTrendDays] = useState(30);
  const trendEnd = metrics[0]?.date ? new Date(metrics[0].date).getTime() : Date.now();
  const trendData = [...metrics]
    .filter((metric) => trendDays === 0 || (trendEnd - new Date(metric.date).getTime()) / 86400000 <= trendDays)
    .reverse()
    .map((metric) => ({
      date: metric.date.slice(5),
      "学习&测验": metric.scoreA,
      "精神&纪律": metric.scoreB,
      "课后任务": metric.scoreC,
      "考勤": metric.scoreD ?? 3,
    }));

  return (
    <section className="student-chart-card">
      <header>
        <div><h2>本学期课次趋势</h2><p>时间范围以本学期最新一条评价为终点。</p></div>
        <Select aria-label="趋势时间范围" value={trendDays} onChange={(event) => setTrendDays(Number(event.target.value))} className="student-trend-range">
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
          <option value={90}>近 90 天</option>
          <option value={0}>全部</option>
        </Select>
      </header>
      {trendData.length > 0 ? (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="date" fontSize={11} />
            <YAxis domain={[0, 5]} tickCount={6} fontSize={11} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="学习&测验" stroke="var(--chart-a)" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="精神&纪律" stroke="var(--chart-b)" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="课后任务" stroke="var(--chart-c)" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="考勤" stroke="var(--chart-d)" strokeWidth={2} dot={{ r: 3 }} strokeDasharray="5 5" />
          </LineChart>
        </ResponsiveContainer>
      ) : <div className="student-chart-empty">本学期暂无课次评价</div>}
    </section>
  );
}
