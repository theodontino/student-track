"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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

export interface DashboardData {
  semester: { id: string; name: string; startDate: string; endDate: string } | null;
  classOverview: ClassOverview[];
  classAlerts: ClassAlert[];
  studentAlerts: StudentAlert[];
  totalStudents: number;
  redCount: number;
  yellowCount: number;
}

interface DashboardOverviewProps {
  data: DashboardData;
  showFeedbackShortcut?: boolean;
}

export default function DashboardOverview({ data, showFeedbackShortcut = false }: DashboardOverviewProps) {
  const router = useRouter();
  const [studentAlertsExpanded, setStudentAlertsExpanded] = useState(false);
  const classAlertMap = new Map<string, ClassAlert[]>();
  for (const alert of data.classAlerts) {
    classAlertMap.set(alert.className, [...(classAlertMap.get(alert.className) ?? []), alert]);
  }

  return (
    <>
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="text-3xl font-bold text-blue-600">{data.totalStudents}</div>
          <div className="mt-1 text-sm text-gray-500">本学期学生</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="text-3xl font-bold text-green-600">{data.classOverview.length}</div>
          <div className="mt-1 text-sm text-gray-500">本学期班级</div>
        </div>
        <div className={`rounded-lg border bg-white p-5 ${data.redCount > 0 ? "border-red-200" : "border-gray-200"}`}>
          <div className={`text-3xl font-bold ${data.redCount > 0 ? "text-red-600" : "text-gray-400"}`}>{data.redCount}</div>
          <div className="mt-1 text-sm text-gray-500">严重预警</div>
        </div>
        <div className={`rounded-lg border bg-white p-5 ${data.yellowCount > 0 ? "border-yellow-200" : "border-gray-200"}`}>
          <div className={`text-3xl font-bold ${data.yellowCount > 0 ? "text-amber-600" : "text-gray-400"}`}>{data.yellowCount}</div>
          <div className="mt-1 text-sm text-gray-500">关注预警</div>
        </div>
      </div>

      {showFeedbackShortcut && (
        <div className="mb-6">
          <h3 className="mb-3 text-lg font-semibold text-gray-800">快捷反馈流程</h3>
          <button
            type="button"
            onClick={() => router.push("/feedback")}
            className="flex w-full items-center gap-4 rounded-lg border-2 border-blue-200 bg-white p-6 text-left transition-all hover:border-blue-400 hover:shadow-md"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-blue-600 text-2xl text-white">→</div>
            <div className="flex-1">
              <div className="mb-1 text-xs text-gray-400">输入 · 确认 · 反馈 · 导出</div>
              <h4 className="text-lg font-bold leading-tight text-gray-800">一键教学反馈</h4>
              <p className="mt-0.5 text-sm text-gray-500">完成课堂记录、批量反馈生成与 Excel 导出</p>
            </div>
            <span className="text-2xl text-blue-400">→</span>
          </button>
        </div>
      )}

      {data.classAlerts.length > 0 && (
        <section className="mb-6">
          <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-800">
            班级预警
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-400">{data.classAlerts.length} 条</span>
          </h3>
          <div className="space-y-2">
            {data.classAlerts.map((alert) => (
              <div key={`${alert.className}-${alert.dimension}`} className={`flex items-center gap-3 rounded-lg border p-3 ${alert.severity === "red" ? "border-red-200 bg-red-50" : "border-yellow-200 bg-yellow-50"}`}>
                <span className={`h-2.5 w-2.5 rounded-full ${alert.severity === "red" ? "bg-red-500" : "bg-amber-400"}`} />
                <div>
                  <span className="font-medium text-gray-800">{alert.className}</span>
                  <span className="ml-2 text-sm text-gray-500">{alert.dimension} 均分 {alert.avgScore}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.studentAlerts.length > 0 && (
        <section className="mb-6">
          <button
            type="button"
            onClick={() => setStudentAlertsExpanded((current) => !current)}
            className="mb-3 flex w-full items-center gap-2 text-left text-lg font-semibold text-gray-800"
          >
            学生预警
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-400">{data.studentAlerts.length} 条</span>
            <span className="ml-auto text-xs font-normal text-gray-400">{studentAlertsExpanded ? "收起 ▲" : "展开 ▼"}</span>
          </button>
          <div className={`space-y-2 ${studentAlertsExpanded ? "" : "max-h-[300px] overflow-hidden"}`}>
            {data.studentAlerts.map((alert) => (
              <button
                type="button"
                key={`${alert.studentId}-${alert.dimension}`}
                onClick={() => router.push(`/students/${alert.studentId}`)}
                className={`flex w-full items-center gap-4 rounded-lg border p-4 text-left transition-shadow hover:shadow-sm ${alert.severity === "red" ? "border-red-200 bg-red-50" : "border-yellow-200 bg-yellow-50"}`}
              >
                <span className={`h-3 w-3 shrink-0 rounded-full ${alert.severity === "red" ? "bg-red-500" : "bg-amber-400"}`} />
                <div className="flex-1">
                  <span className="font-medium text-gray-800">{alert.studentName}</span>
                  <span className="ml-2 text-xs text-gray-400">{alert.class} · {alert.dimension}</span>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {alert.dimension === "考勤"
                      ? `累计缺勤 ${alert.score} 次，本班共 ${alert.classAvg} 次课`
                      : `得分 ${alert.score}，班级均分 ${alert.classAvg}，偏差 ${alert.deviation}`}
                  </p>
                </div>
                <span className="text-sm text-gray-400">查看 →</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {data.totalStudents > 0 && data.classAlerts.length === 0 && data.studentAlerts.length === 0 && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-10 text-center text-gray-400">本学期无预警</div>
      )}
      {data.totalStudents === 0 && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-10 text-center text-gray-400">
          {data.semester ? `${data.semester.name} 暂无学生状态记录` : "暂无可用学期"}
        </div>
      )}

      <section>
        <h3 className="mb-3 text-lg font-semibold text-gray-800">班级概览</h3>
        {data.classOverview.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {data.classOverview.map((classItem) => {
              const alerts = classAlertMap.get(classItem.name) ?? [];
              const hasRed = alerts.some((alert) => alert.severity === "red");
              const hasYellow = alerts.some((alert) => alert.severity === "yellow");
              return (
                <div key={classItem.name} className={`rounded-lg border bg-white p-5 ${hasRed ? "border-red-200" : hasYellow ? "border-yellow-200" : "border-gray-200"}`}>
                  <div className="mb-4 flex items-center justify-between">
                    <h4 className="font-semibold text-gray-800">{classItem.name}</h4>
                    <span className="text-xs text-gray-400">{classItem.studentCount} 名学生</span>
                  </div>
                  <div className="space-y-3">
                    {[
                      { label: "学习&测验", value: classItem.avgA, color: "bg-blue-500" },
                      { label: "精神&纪律", value: classItem.avgB, color: "bg-green-500" },
                      { label: "课后任务", value: classItem.avgC, color: "bg-amber-500" },
                      { label: "考勤", value: classItem.avgD, color: "bg-purple-500" },
                    ].map((dimension) => {
                      const alert = alerts.find((item) => item.dimension === dimension.label);
                      return (
                        <div key={dimension.label} className="flex items-center gap-3">
                          <span className="w-16 text-xs text-gray-500">{dimension.label}</span>
                          <div className="h-2 flex-1 rounded-full bg-gray-100">
                            <div className={`h-2 rounded-full ${dimension.color}`} style={{ width: `${(dimension.value / 5) * 100}%` }} />
                          </div>
                          <span className={`w-10 text-right font-mono text-sm font-medium ${alert?.severity === "red" ? "text-red-600" : alert ? "text-amber-600" : "text-gray-700"}`}>{dimension.value}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-10 text-center text-gray-400">暂无班级状态记录</div>
        )}
      </section>
    </>
  );
}
