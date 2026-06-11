"use client";

import { useState, useEffect } from "react";

interface LogEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  targetName: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  "score.updated": "评分更新",
  "alert.triggered": "预警触发",
  "student.deleted": "学生删除",
  "session.created": "课次创建",
  "session.deleted": "课次删除",
  "data.exported": "数据导出",
};

const TARGET_LABELS: Record<string, string> = {
  Student: "学生",
  Session: "课次",
  Draft: "草案",
  Class: "班级",
  System: "系统",
};

export default function SystemLogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filterAction, setFilterAction] = useState("");
  const [filterTargetName, setFilterTargetName] = useState("");
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  useEffect(() => {
    async function fetchInitialLogs() {
      setLoading(true);
      const params = new URLSearchParams({ limit: String(LIMIT), offset: "0" });
      if (filterAction) params.set("action", filterAction);
      if (filterTargetName) params.set("targetName", filterTargetName);

      const res = await fetch(`/api/system/logs?${params}`);
      const data = await res.json();
      if (!res.ok || !data.logs) {
        setLoading(false);
        return;
      }
      setLogs(data.logs);
      setOffset(LIMIT);
      setTotal(data.total ?? 0);
      setLoading(false);
    }

    void fetchInitialLogs();
  }, [filterAction, filterTargetName]);

  async function loadMoreLogs() {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    if (filterAction) params.set("action", filterAction);
    if (filterTargetName) params.set("targetName", filterTargetName);

    const res = await fetch(`/api/system/logs?${params}`);
    const data = await res.json();
    if (!res.ok || !data.logs) {
      setLoading(false);
      return;
    }
    setLogs((prev) => [...prev, ...data.logs]);
    setOffset(offset + LIMIT);
    setTotal(data.total ?? 0);
    setLoading(false);
  }

  function formatDetail(detail: Record<string, unknown>): string {
    if (!detail || Object.keys(detail).length === 0) return "—";
    return Object.entries(detail)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" | ");
  }

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-xl font-bold text-gray-800 mb-1">系统操作日志</h2>
      <p className="text-sm text-gray-500 mb-6">
        记录评分变更、预警触发、数据删除等关键操作，共 {total} 条。保留 90 天。
      </p>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <select value={filterAction} onChange={(e) => { setFilterAction(e.target.value); setOffset(0); }}
          className="text-sm border border-gray-300 rounded px-3 py-1.5 outline-none">
          <option value="">全部操作类型</option>
          {Object.entries(ACTION_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <input
          type="text" placeholder="搜索学生名..."
          value={filterTargetName}
          onChange={(e) => { setFilterTargetName(e.target.value); setOffset(0); }}
          className="text-sm border border-gray-300 rounded px-3 py-1.5 outline-none w-40"
        />
      </div>

      {loading && logs.length === 0 ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin h-8 w-8 border-2 border-blue-600 border-t-transparent rounded-full" />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-3xl mb-2">📋</p>
          <p>暂无操作日志</p>
          <p className="text-xs mt-1">评分、删除等操作发生后会自动记录</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 text-gray-600 font-medium">时间</th>
                  <th className="text-left px-4 py-2.5 text-gray-600 font-medium">操作</th>
                  <th className="text-left px-4 py-2.5 text-gray-600 font-medium">对象</th>
                  <th className="text-left px-4 py-2.5 text-gray-600 font-medium">详情</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-gray-100 hover:bg-gray-50/50">
                    <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString("zh-CN")}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">
                        {ACTION_LABELS[log.action] || log.action}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-gray-500 mr-1.5">
                        {TARGET_LABELS[log.targetType] || log.targetType}
                      </span>
                      {log.targetName && (
                        <span className="text-gray-800 font-medium">{log.targetName}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 max-w-xs truncate">
                      {formatDetail(log.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > logs.length && (
            <button onClick={loadMoreLogs}
              className="mt-4 w-full text-center text-sm text-blue-600 hover:text-blue-800 py-2 rounded hover:bg-blue-50">
              加载更多（{logs.length}/{total}）
            </button>
          )}
        </>
      )}
    </div>
  );
}
