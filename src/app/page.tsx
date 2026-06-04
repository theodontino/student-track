"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface ClassOverview {
  name: string;
  avgA: number;
  avgB: number;
  avgC: number;
  avgD?: number;
  studentCount: number;
}

interface Alert {
  studentId: string;
  studentName: string;
  class: string;
  dimension: string;
  reason: string;
  severity: "red" | "yellow";
}

interface DashboardData {
  classOverview: ClassOverview[];
  alerts: Alert[];
  totalStudents: number;
  alertCount: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">仪表盘</h2>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
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
        <div
          className={`bg-white rounded-xl border p-5 ${
            data.alertCount > 0 ? "border-red-200" : "border-gray-200"
          }`}
        >
          <div
            className={`text-3xl font-bold ${
              data.alertCount > 0 ? "text-red-600" : "text-green-600"
            }`}
          >
            {data.alertCount}
          </div>
          <div className="text-sm text-gray-500 mt-1">
            {data.alertCount > 0 ? "预警学生" : "无预警"}
          </div>
        </div>
      </div>

      {/* Alerts Section */}
      {data.alerts.length > 0 && (
        <div className="mb-8">
          <h3 className="text-lg font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <span>🚨 预警列表</span>
            <span className="text-xs font-normal text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
              {data.alerts.length} 条
            </span>
          </h3>
          <div className="space-y-2">
            {data.alerts.map((alert, idx) => (
              <div
                key={idx}
                onClick={() => router.push(`/students/${alert.studentId}`)}
                className={`flex items-center gap-4 p-4 rounded-lg cursor-pointer hover:shadow-sm transition-shadow ${
                  alert.severity === "red"
                    ? "bg-red-50 border border-red-200"
                    : "bg-yellow-50 border border-yellow-200"
                }`}
              >
                <span
                  className={`text-lg ${
                    alert.severity === "red" ? "text-red-500" : "text-yellow-500"
                  }`}
                >
                  {alert.severity === "red" ? "🔴" : "🟡"}
                </span>
                <div className="flex-1">
                  <span className="font-medium text-gray-800">
                    {alert.studentName}
                  </span>
                  <span className="text-xs text-gray-400 ml-2">
                    {alert.class}
                  </span>
                  <span className="text-xs text-gray-400 ml-2">
                    · {alert.dimension}
                  </span>
                  <p className="text-xs text-gray-500 mt-0.5">{alert.reason}</p>
                </div>
                <span className="text-gray-400 text-sm">查看 →</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Class Overview */}
      <div>
        <h3 className="text-lg font-semibold text-gray-800 mb-3">
          📊 班级概览
        </h3>
        {data.classOverview.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.classOverview.map((cls) => (
              <div
                key={cls.name}
                className="bg-white rounded-xl border border-gray-200 p-5"
              >
                <div className="flex items-center justify-between mb-4">
                  <h4 className="font-semibold text-gray-800">{cls.name}</h4>
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
                  ].map((item) => (
                    <div key={item.label} className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 w-16">
                        {item.label}
                      </span>
                      <div className="flex-1 bg-gray-100 rounded-full h-2">
                        <div
                          className={`${item.color} h-2 rounded-full transition-all`}
                          style={{ width: `${(item.value / 5) * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-mono font-medium text-gray-700 w-6 text-right">
                        {item.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">
            <p className="text-3xl mb-2">📭</p>
            <p>暂无数据，请先录入学生表现</p>
          </div>
        )}
      </div>
    </div>
  );
}
