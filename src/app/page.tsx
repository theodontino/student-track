"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import ArchiveButton from "@/components/ArchiveButton";

interface ClassOverview {
  name: string;
  avgA: number;
  avgB: number;
  avgC: number;
  avgD?: number;
  studentCount: number;
}

interface ClassAlert {
  className: string;
  dimension: string;
  avgScore: number;
  severity: "red" | "yellow";
}

interface StudentAlert {
  studentId: string;
  studentName: string;
  class: string;
  dimension: string;
  score: number;
  classAvg: number;
  deviation: number;
  severity: "red" | "yellow";
}

interface DashboardData {
  classOverview: ClassOverview[];
  classAlerts: ClassAlert[];
  studentAlerts: StudentAlert[];
  totalStudents: number;
  redCount: number;
  yellowCount: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [studentAlertsExpanded, setStudentAlertsExpanded] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const res = await fetch("/api/alerts");
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-2 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!data) return null;

  // Find class alerts for a specific class
  const classAlertMap = new Map<string, ClassAlert[]>();
  for (const ca of data.classAlerts) {
    const arr = classAlertMap.get(ca.className) || [];
    arr.push(ca);
    classAlertMap.set(ca.className, arr);
  }

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">仪表盘</h2>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="text-3xl font-bold text-blue-600">
            {data.totalStudents}
          </div>
          <div className="text-sm text-gray-500 mt-1">学生总数</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="text-3xl font-bold text-green-600">
            {data.classOverview.length}
          </div>
          <div className="text-sm text-gray-500 mt-1">班级数</div>
        </div>
        <div className={`bg-white rounded-xl border p-5 ${data.redCount > 0 ? "border-red-200" : "border-gray-200"}`}>
          <div className={`text-3xl font-bold ${data.redCount > 0 ? "text-red-600" : "text-gray-400"}`}>
            {data.redCount}
          </div>
          <div className="text-sm text-gray-500 mt-1">🔴 严重预警</div>
        </div>
        <div className={`bg-white rounded-xl border p-5 ${data.yellowCount > 0 ? "border-yellow-200" : "border-gray-200"}`}>
          <div className={`text-3xl font-bold ${data.yellowCount > 0 ? "text-amber-600" : "text-gray-400"}`}>
            {data.yellowCount}
          </div>
          <div className="text-sm text-gray-500 mt-1">🟡 关注预警</div>
        </div>
      </div>

      {/* v0.13: 快捷反馈流程 */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-3 flex items-center gap-2">
          <span>🚀 快捷反馈流程</span>
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { href: "/input", icon: "✏️", label: "输入", desc: "NL 自然语言录入", color: "bg-blue-500" },
            { href: "/review", icon: "✅", label: "确认", desc: "复核 LLM 解析结果", color: "bg-green-500" },
            { href: "/report", icon: "📋", label: "反馈", desc: "生成家长反馈报告", color: "bg-amber-500" },
            { href: "/export", icon: "📥", label: "导出", desc: "导出 Excel 归档", color: "bg-purple-500" },
          ].map((item) => (
            <div
              key={item.href}
              onClick={() => router.push(item.href)}
              className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
            >
              <div className={`w-10 h-10 rounded-lg ${item.color} flex items-center justify-center text-white text-lg mb-3`}>
                {item.icon}
              </div>
              <h4 className="font-semibold text-gray-800 text-sm">{item.label}</h4>
              <p className="text-xs text-gray-400 mt-0.5">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Class Alerts */}
      {data.classAlerts.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <span>🏫 班级预警</span>
            <span className="text-xs font-normal text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
              {data.classAlerts.length} 条
            </span>
          </h3>
          <div className="space-y-2">
            {data.classAlerts.map((ca) => (
              <div
                key={ca.className + ca.dimension}
                className={`flex items-center gap-3 p-3 rounded-lg ${
                  ca.severity === "red"
                    ? "bg-red-50 border border-red-200"
                    : "bg-yellow-50 border border-yellow-200"
                }`}
              >
                <span className="text-lg">
                  {ca.severity === "red" ? "🔴" : "🟡"}
                </span>
                <div>
                  <span className="font-medium text-gray-800">{ca.className}</span>
                  <span className="text-sm text-gray-500 ml-2">
                    {ca.dimension} 均分 {ca.avgScore}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Student Alerts — collapsible */}
      {data.studentAlerts.length > 0 && (
        <div className="mb-6">
          <h3
            className="text-lg font-semibold text-gray-800 mb-3 flex items-center gap-2 cursor-pointer select-none"
            onClick={() => setStudentAlertsExpanded(!studentAlertsExpanded)}
          >
            <span>👤 学生预警</span>
            <span className="text-xs font-normal text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
              {data.studentAlerts.length} 条
            </span>
            <span className="text-xs text-gray-400 ml-auto">
              {studentAlertsExpanded ? "收起 ▲" : "展开 ▼"}
            </span>
          </h3>
          <div className={`space-y-2 ${!studentAlertsExpanded ? "max-h-[300px] overflow-hidden" : ""}`}>
            {data.studentAlerts.map((sa) => (
              <div
                key={sa.studentId + sa.dimension}
                onClick={() => router.push(`/students/${sa.studentId}`)}
                className={`flex items-center gap-4 p-4 rounded-lg cursor-pointer hover:shadow-sm transition-shadow ${
                  sa.severity === "red"
                    ? "bg-red-50 border border-red-200"
                    : "bg-yellow-50 border border-yellow-200"
                }`}
              >
                <span className="text-lg">
                  {sa.severity === "red" ? "🔴" : "🟡"}
                </span>
                <div className="flex-1">
                  <span className="font-medium text-gray-800">{sa.studentName}</span>
                  <span className="text-xs text-gray-400 ml-2">{sa.class}</span>
                  <span className="text-xs text-gray-400 ml-2">· {sa.dimension}</span>
                  <p className="text-xs text-gray-500 mt-0.5">
                    得分 {sa.score}，班级均分 {sa.classAvg}
                    {sa.dimension !== "考勤" ? `，偏差 ${sa.deviation}` : `，缺勤 ${sa.score} 次`}
                  </p>
                </div>
                <span className="text-gray-400 text-sm">查看 →</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No alerts */}
      {data.classAlerts.length === 0 && data.studentAlerts.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400 mb-6">
          <p className="text-3xl mb-2">✅</p>
          <p>当前无预警</p>
        </div>
      )}

      {/* Class Overview */}
      <div>
        <h3 className="text-lg font-semibold text-gray-800 mb-3">
          📊 班级概览
        </h3>
        {data.classOverview.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.classOverview.map((cls) => {
              const alerts = classAlertMap.get(cls.name) || [];
              const hasRed = alerts.some((a) => a.severity === "red");
              const hasYellow = alerts.some((a) => a.severity === "yellow");
              return (
                <div
                  key={cls.name}
                  className={`bg-white rounded-xl border p-5 ${
                    hasRed ? "border-red-200" : hasYellow ? "border-yellow-200" : "border-gray-200"
                  }`}
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-gray-800">{cls.name}</h4>
                      {hasRed && <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">🔴</span>}
                      {hasYellow && !hasRed && <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded font-medium">🟡</span>}
                    </div>
                    <span className="text-xs text-gray-400">
                      {cls.studentCount} 名学生
                    </span>
                  </div>
                  <div className="space-y-3">
                    {[
                      { label: "学习&测验", value: cls.avgA, color: "bg-blue-500" },
                      { label: "精神&纪律", value: cls.avgB, color: "bg-green-500" },
                      { label: "课后任务", value: cls.avgC, color: "bg-amber-500" },
                      { label: "考勤", value: cls.avgD ?? 3, color: "bg-purple-500" },
                    ].map((item) => {
                      const alert = alerts.find((a) => a.dimension === item.label);
                      return (
                        <div key={item.label} className="flex items-center gap-3">
                          <span className="text-xs text-gray-500 w-16">{item.label}</span>
                          <div className="flex-1 bg-gray-100 rounded-full h-2">
                            <div
                              className={`${item.color} h-2 rounded-full transition-all`}
                              style={{ width: `${(item.value / 5) * 100}%` }}
                            />
                          </div>
                          <span className={`text-sm font-mono font-medium w-10 text-right ${
                            alert ? (alert.severity === "red" ? "text-red-600" : "text-amber-600") : "text-gray-700"
                          }`}>
                            {item.value}
                            {alert && <span className="ml-0.5 text-xs">{alert.severity === "red" ? "❗" : "⚠"}</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">
            <p className="text-3xl mb-2">📭</p>
            <p>暂无数据，请先录入学生表现</p>
          </div>
        )}
      </div>

      {/* 系统操作 */}
      <div className="mt-10 pt-6 border-t border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <ArchiveButton onSuccess={fetchData} />
          <a href="/system-logs"
            className="text-xs text-gray-400 hover:text-blue-600 transition-colors">
            📋 操作日志
          </a>
        </div>
        <p className="text-xs text-gray-300 mt-2">
          定期运行 <code className="bg-gray-100 px-1 rounded">npm run db:maintain</code> 保持数据库健康
        </p>
      </div>
    </div>
  );
}
