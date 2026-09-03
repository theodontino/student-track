"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, EmptyState, ErrorState, LoadingState, PageHeader, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { SemesterDialog } from "./SemesterDialog";

interface Semester { id: string; name: string; startDate: string; endDate: string; sessionCount: number; }
interface RecycleItem { kind: "semester" | "class"; id: string; name: string; deletedAt: string; purgeAt: string; daysRemaining: number; restorable?: boolean; semester?: { id: string; name: string; deletedAt: string | null }; }
interface RecycleBin { retentionDays: number; semesters: RecycleItem[]; classes: RecycleItem[]; }

export default function SemestersWorkspace() {
  const router = useRouter();
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [recycleBin, setRecycleBin] = useState<RecycleBin | null>(null);
  const [recycleMessage, setRecycleMessage] = useState("");
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      void requestJson("/api/recycle-bin/purge-expired", { method: "POST" }).catch(() => undefined);
      setSemesters(await requestJson<Semester[]>("/api/semesters"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载学期失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRecycleBin = useCallback(async () => {
    setRecycleMessage("");
    try { setRecycleBin(await requestJson<RecycleBin>("/api/recycle-bin")); }
    catch (reason) { setRecycleMessage(reason instanceof Error ? reason.message : "读取回收站失败"); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function openRecycleBin() {
    setRecycleOpen(true);
    await loadRecycleBin();
  }

  async function restore(item: RecycleItem) {
    setRestoringId(item.id);
    setRecycleMessage("");
    try {
      await requestJson(`/api/${item.kind === "semester" ? "semesters" : "classes"}/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
      await Promise.all([loadRecycleBin(), load()]);
    } catch (reason) {
      setRecycleMessage(reason instanceof Error ? reason.message : "恢复失败");
    } finally {
      setRestoringId(null);
    }
  }

  if (loading) return <LoadingState label="正在加载学期…" />;
  if (error) return <ErrorState message={error} action={<Button onClick={() => void load()}>重试</Button>} />;
  const recycleItems = recycleBin ? [...recycleBin.semesters, ...recycleBin.classes] : [];
  return <main className="semesters-workspace">
    <PageHeader title="学期 / 课次" description="管理教学周期并进入课次详情。" actions={<div className="semester-detail-actions"><Button variant="secondary" onClick={() => void openRecycleBin()}>回收站</Button><Button onClick={() => setDialogOpen(true)}>新建学期</Button></div>} />
    {semesters.length === 0
      ? <EmptyState title="暂无学期" description="新建学期后即可开始管理课次。" action={<Button onClick={() => setDialogOpen(true)}>新建第一个学期</Button>} />
      : <div className="semester-list">{semesters.map((semester) => <button type="button" key={semester.id} onClick={() => router.push(`/semesters/${semester.id}`)}><span><strong>{semester.name}</strong><small>{semester.startDate} → {semester.endDate}</small></span><span><strong>{semester.sessionCount}</strong><small>课次</small></span></button>)}</div>}
    <SemesterDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSaved={(semester) => setSemesters((current) => [semester as Semester, ...current])} />
    <Dialog open={recycleOpen} title="回收站" onClose={() => setRecycleOpen(false)}>
      <div className="dialog-form">
        <p className="dialog-form__hint">班级和学期可在 30 天内恢复。到期项目会先备份数据库，再永久清除。</p>
        {recycleMessage && <StatusBanner tone="danger">{recycleMessage}</StatusBanner>}
        {!recycleBin ? <LoadingState label="正在读取回收站…" /> : recycleItems.length === 0 ? <EmptyState title="回收站为空" /> : <div className="recycle-bin-list">
          {recycleItems.map((item) => <div className="recycle-bin-item" key={`${item.kind}:${item.id}`}>
            <div><strong>{item.name}</strong><small>{item.kind === "semester" ? "学期" : `班级 · ${item.semester?.name ?? ""}`} · 剩余 {item.daysRemaining} 天</small></div>
            <Button uiSize="sm" variant="secondary" disabled={restoringId !== null || item.restorable === false} onClick={() => void restore(item)}>{item.restorable === false ? "先恢复学期" : restoringId === item.id ? "恢复中…" : "恢复"}</Button>
          </div>)}
        </div>}
        <div className="dialog-form__actions"><Button variant="secondary" onClick={() => setRecycleOpen(false)}>关闭</Button></div>
      </div>
    </Dialog>
  </main>;
}
