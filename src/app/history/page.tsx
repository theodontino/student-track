"use client";

import { useEffect, useState } from "react";
import type { HistoryModule, WorkHistory } from "@/lib/history";

const MODULES: Array<{ id: HistoryModule; label: string }> = [
  { id: "feedback", label: "课后反馈" },
  { id: "quick-score", label: "快速评分" },
  { id: "input", label: "NL 录入" },
  { id: "report", label: "报告" },
  { id: "export", label: "导出" },
];

export default function HistoryPage() {
  const [module, setModule] = useState<HistoryModule>("feedback");
  const [items, setItems] = useState<WorkHistory<any>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    fetch(`/api/history?module=${encodeURIComponent(module)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "加载历史失败");
        if (!cancelled) setItems(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载历史失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [module]);

  async function remove(id: string) {
    if (!confirm("删除这条历史记录？")) return;
    const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) setItems((current) => current.filter((item) => item.id !== id));
  }

  async function clearAll() {
    if (!items.length || !confirm("清空当前模块的全部历史？此操作不可撤销。")) return;
    const response = await fetch(`/api/history?module=${encodeURIComponent(module)}`, { method: "DELETE" });
    if (response.ok) setItems([]);
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">历史记录</h2>
          <p className="text-sm text-gray-500 mt-1">查看和清理可恢复的页面工作状态；恢复仍在对应业务页面完成。</p>
        </div>
        <button
          type="button"
          onClick={() => void clearAll()}
          disabled={!items.length}
          className="rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
        >
          清空当前模块
        </button>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {MODULES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setModule(item.id)}
            className={`rounded-md border px-3 py-2 text-sm font-medium ${
              module === item.id
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        {loading && <div className="p-10 text-center text-sm text-gray-400">加载中...</div>}
        {error && <div className="m-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
        {!loading && !error && items.length === 0 && (
          <div className="p-10 text-center text-sm text-gray-400">暂无历史记录</div>
        )}
        {!loading && !error && items.length > 0 && (
          <div className="divide-y divide-gray-100">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-gray-800">{item.title}</div>
                  <div className="mt-1 text-xs text-gray-400">
                    {new Date(item.createdAt).toLocaleString("zh-CN")}
                    {item.key ? ` · ${item.key}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void remove(item.id)}
                  className="text-sm text-red-500 hover:text-red-700"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
