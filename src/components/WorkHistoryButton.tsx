"use client";

import { useEffect, useState } from "react";
import type { HistoryModule, WorkHistory } from "@/lib/history";
import { requestJson } from "@/lib/api-client";
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/ui";

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
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const targets = modules ?? (module ? [module] : []);
    Promise.all(targets.map((target) => requestJson<WorkHistory<unknown>[]>(`/api/history?module=${encodeURIComponent(target)}`)))
      .then((groups) => { if (!cancelled) setItems(groups.flat().filter((item): item is WorkHistory<T> => accept ? accept(item.state) : true).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "加载历史失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accept, module, modules, open]);

  async function remove(id: string) {
    setDeleting(true);
    setError("");
    try {
      await requestJson(`/api/history?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== id));
      setDeleteTarget(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除历史失败");
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  async function clearAll() {
    if (!items.length) return;
    const targets = modules ?? (module ? [module] : []);
    setDeleting(true);
    setError("");
    try {
      await (accept || targets.length > 1
        ? Promise.all(items.map((item) => requestJson(`/api/history?id=${encodeURIComponent(item.id)}`, { method: "DELETE" })))
        : Promise.all(targets.map((target) => requestJson(`/api/history?module=${encodeURIComponent(target)}`, { method: "DELETE" }))));
      setItems([]);
      setClearConfirmationOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "清空历史失败");
      setClearConfirmationOpen(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>历史</Button>

      <Dialog open={open} title="工作历史" size="wide" onClose={() => setOpen(false)}>
        <div className="flex max-h-[65vh] flex-col">
          <p className="px-5 pt-4 text-xs text-gray-500">恢复只更新当前页面，不会自动写入业务数据。</p>
          <div className="flex-1 overflow-y-auto p-5">
              {loading && <LoadingState label="正在加载工作历史…" />}
              {error && <ErrorState message={error} />}
              {!loading && !error && items.length === 0 && <EmptyState title="暂无历史记录" />}
              <div className="space-y-2">
                {items.map((item) => (
                  <div key={item.id} className="border border-gray-200 rounded-lg p-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-800 truncate">{item.title}</p>
                      <p className="text-xs text-gray-400 mt-1">{new Date(item.createdAt).toLocaleString("zh-CN")}</p>
                    </div>
                    <Button uiSize="sm" variant="ghost" onClick={() => { onRestore(item.state); setOpen(false); }}>恢复</Button>
                    <Button uiSize="sm" variant="danger" onClick={() => setDeleteTarget(item.id)}>删除</Button>
                  </div>
                ))}
              </div>
          </div>
          <div className="flex justify-between border-t border-gray-200 p-4">
            <Button variant="danger" uiSize="sm" onClick={() => setClearConfirmationOpen(true)} disabled={!items.length}>清空全部</Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>关闭</Button>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除历史记录"
        description="确定删除这条工作历史？此操作不会删除学生业务数据。"
        confirmLabel="删除"
        danger
        busy={deleting}
        onConfirm={() => deleteTarget && void remove(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
      />
      <ConfirmDialog
        open={clearConfirmationOpen}
        title="清空工作历史"
        description="确定清空当前模块的全部工作历史？此操作不可撤销，但不会删除学生业务数据。"
        confirmLabel="清空全部"
        danger
        busy={deleting}
        onConfirm={() => void clearAll()}
        onClose={() => setClearConfirmationOpen(false)}
      />
    </>
  );
}
