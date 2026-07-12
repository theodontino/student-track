"use client";

import { useEffect, useState } from "react";
import type { HistoryModule, WorkHistory } from "@/lib/history";

interface Props<T> {
  module?: HistoryModule;
  modules?: readonly HistoryModule[];
  accept?: (state: unknown) => state is T;
  onRestore: (state: T) => void;
}

export default function WorkHistoryButton<T>({ module, modules, accept, onRestore }: Props<T>) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<WorkHistory<T>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const targets = modules ?? (module ? [module] : []);
    Promise.all(targets.map(async (target) => { const response = await fetch(`/api/history?module=${encodeURIComponent(target)}`); const data = await response.json(); if (!response.ok) throw new Error(data.error || "加载历史失败"); return data as WorkHistory<unknown>[]; }))
      .then((groups) => { if (!cancelled) setItems(groups.flat().filter((item): item is WorkHistory<T> => accept ? accept(item.state) : true).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "加载历史失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accept, module, modules, open]);

  async function remove(id: string) {
    if (!confirm("删除这条历史记录？")) return;
    const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) setItems((current) => current.filter((item) => item.id !== id));
  }

  async function clearAll() {
    if (!items.length || !confirm("清空当前模块的全部历史？此操作不可撤销。")) return;
    const targets = modules ?? (module ? [module] : []);
    const responses = accept || targets.length > 1
      ? await Promise.all(items.map((item) => fetch(`/api/history?id=${encodeURIComponent(item.id)}`, { method: "DELETE" })))
      : await Promise.all(targets.map((target) => fetch(`/api/history?module=${encodeURIComponent(target)}`, { method: "DELETE" })));
    if (responses.every((response) => response.ok)) setItems([]);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-gray-300 bg-white text-gray-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-gray-50"
      >
        历史
      </button>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4" onClick={() => setOpen(false)}>
          <div className="bg-white border border-gray-200 rounded-lg shadow-xl w-full max-w-xl max-h-[75vh] flex flex-col" onClick={(event) => event.stopPropagation()}>
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-800">工作历史</h3>
                <p className="text-xs text-gray-500 mt-0.5">恢复只更新当前页面，不会自动写入业务数据。</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="关闭" className="text-gray-400 hover:text-gray-700 text-xl px-2">×</button>
            </div>

            <div className="p-4 overflow-y-auto flex-1">
              {loading && <p className="text-sm text-gray-400 text-center py-10">加载中...</p>}
              {error && <p className="text-sm text-red-600 bg-red-50 p-3 rounded-lg">{error}</p>}
              {!loading && !error && items.length === 0 && <p className="text-sm text-gray-400 text-center py-10">暂无历史记录</p>}
              <div className="space-y-2">
                {items.map((item) => (
                  <div key={item.id} className="border border-gray-200 rounded-lg p-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-800 truncate">{item.title}</p>
                      <p className="text-xs text-gray-400 mt-1">{new Date(item.createdAt).toLocaleString("zh-CN")}</p>
                    </div>
                    <button type="button" onClick={() => { onRestore(item.state); setOpen(false); }} className="text-sm text-blue-600 hover:text-blue-800 font-medium">恢复</button>
                    <button type="button" onClick={() => void remove(item.id)} className="text-sm text-red-500 hover:text-red-700">删除</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-4 border-t border-gray-200 flex justify-between">
              <button type="button" onClick={() => void clearAll()} disabled={!items.length} className="text-sm text-red-600 disabled:text-gray-300">清空全部</button>
              <button type="button" onClick={() => setOpen(false)} className="border border-gray-300 px-4 py-2 rounded-lg text-sm text-gray-700">关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
