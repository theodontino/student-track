"use client";

import { useState } from "react";
import WorkHistoryButton from "@/components/WorkHistoryButton";
import { saveWorkHistory } from "@/lib/history";

interface ExportHistoryState { startDate: string; endDate: string; }

export default function ExportWorkspace() {
  const today = new Date().toISOString().split("T")[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000)
    .toISOString()
    .split("T")[0];

  const [startDate, setStartDate] = useState(thirtyDaysAgo);
  const [endDate, setEndDate] = useState(today);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleExport() {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "导出失败");
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Chem-Track_${startDate}_${endDate}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
      try {
        await saveWorkHistory("export", `${startDate} 至 ${endDate} 数据导出`, { startDate, endDate }, `${startDate}:${endDate}`);
      } catch (historyError) { console.error("save export history failed:", historyError); }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-bold text-gray-800">数据导出</h2>
        <WorkHistoryButton<ExportHistoryState> module="export" onRestore={(state) => { setStartDate(state.startDate); setEndDate(state.endDate); setError(""); }} />
      </div>
      <p className="text-sm text-gray-500 mb-6">
        选择时间范围，导出学生数据的 Excel 文件 (.xlsx)。
      </p>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              开始日期
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              结束日期
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            />
          </div>

          <div className="bg-gray-50 rounded-lg p-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-2">
              导出内容包含 5 个 Sheet：
            </h4>
            <ul className="text-xs text-gray-500 space-y-1">
              <li>📋 Sheet 1: 学生档案（姓名、班级、学号、标签、当前状态）</li>
              <li>📊 Sheet 2: 每日指标历史（日期、维度A/B/C、操作人）</li>
              <li>📝 Sheet 3: 关键事件日志（日期、事件类型、描述、原始文本）</li>
              <li>📞 Sheet 4: 家校沟通记录（日期、沟通对象、内容摘要）</li>
              <li>✅ Sheet 5: 考勤记录（日期、课次、出勤状态）</li>
            </ul>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 text-sm p-3 rounded-lg">
              {error}
            </div>
          )}

          <button
            onClick={handleExport}
            disabled={loading}
            className="w-full bg-green-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg
                  className="animate-spin h-4 w-4"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                生成中...
              </span>
            ) : (
              "📥 导出 Excel"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
