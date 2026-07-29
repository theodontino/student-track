"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  Select,
  StatusBanner,
  Textarea,
} from "@/components/ui";
import { requestJson } from "@/lib/api-client";

interface GenerationRecordView {
  id: string;
  taskType: string;
  stage: string;
  lifecycle: "hot" | "warm" | "purged";
  modelName: string;
  generatedAt: string;
  adoptedAt: string | null;
  sessionId: string | null;
  studentId: string | null;
  inputSnapshot: string | null;
  outputSnapshot: string | null;
  warmSnapshot: string | null;
}

interface LongTermDraftView { id: string; scopeName: string; content: string; generatedAt: string; }
interface ClassOption { id: string; code: string; name: string | null; }
interface UndoableRunView {
  id: string;
  classId: string;
  className: string;
  affectedCount: number;
  completedAt: string | null;
  undoUntil: string;
}
interface TeachingMemoryResponse {
  history: GenerationRecordView[];
  drafts: LongTermDraftView[];
  classes: ClassOption[];
  undoableRuns: UndoableRunView[];
}
interface DraftGenerationResult {
  drafts: number;
  skipped: boolean;
  reason: string | null;
  skippedScopes: number;
}

const lifecycleLabel = { hot: "完整可复盘", warm: "学期快照", purged: "长期已清理" } as const;
const skipReason: Record<string, string> = {
  no_eligible_sessions: "该班暂无来源课次已满六个月。",
  no_eligible_warm_records: "该班暂无到期的学期快照。",
  no_reliable_semester_summary: "到期记录没有可用的受控学期摘要，已安全跳过且未调用模型。",
  already_processed: "相同来源已经处理过，没有重复生成。",
};

export function GenerationHistoryPanel() {
  const [items, setItems] = useState<GenerationRecordView[] | null>(null);
  const [drafts, setDrafts] = useState<LongTermDraftView[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [undoableRuns, setUndoableRuns] = useState<UndoableRunView[]>([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busyAction, setBusyAction] = useState<"draft" | "undo" | "confirm" | null>(null);
  const [undoTarget, setUndoTarget] = useState<UndoableRunView | null>(null);

  const load = useCallback(async () => {
    const data = await requestJson<TeachingMemoryResponse>("/api/teaching-memory?operations=1");
    setItems(data.history);
    setDrafts(data.drafts);
    setClasses(data.classes);
    setUndoableRuns(data.undoableRuns);
    setSelectedClassId((current) => current || data.classes[0]?.id || "");
  }, []);

  useEffect(() => {
    let active = true;
    void load()
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "加载 AI 生成历史失败"); });
    return () => { active = false; };
  }, [load]);

  async function generateDrafts() {
    if (!selectedClassId) return;
    setBusyAction("draft"); setError(""); setStatus("");
    try {
      const result = await requestJson<DraftGenerationResult>("/api/teaching-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "long-term-drafts", classId: selectedClassId }),
      });
      setStatus(result.skipped
        ? skipReason[result.reason ?? ""] ?? "没有需要生成的长期背景草案。"
        : `已生成 ${result.drafts} 条长期背景草案${result.skippedScopes ? `，另有 ${result.skippedScopes} 个范围因缺少可靠摘要而跳过` : ""}；请逐条核对后确认。`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生成长期背景草案失败");
    } finally {
      setBusyAction(null);
    }
  }

  async function confirmDraft(draft: LongTermDraftView) {
    setBusyAction("confirm"); setError(""); setStatus("");
    try {
      await requestJson("/api/teaching-memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft.id, content: draft.content }),
      });
      setDrafts((current) => current.filter((item) => item.id !== draft.id));
      setStatus("长期背景已确认并保留，仅供教师内部查看。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "确认长期背景失败");
    } finally {
      setBusyAction(null);
    }
  }

  async function undoCompaction() {
    if (!undoTarget) return;
    setBusyAction("undo"); setError(""); setStatus("");
    try {
      await requestJson("/api/teaching-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo", runId: undoTarget.id }),
      });
      setUndoTarget(null);
      setStatus("学期快照压缩已撤销，窗口内的完整生成记录已恢复。");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "撤销学期快照失败");
    } finally {
      setBusyAction(null);
    }
  }

  if (error && items === null) return <ErrorState message={error} />;
  if (items === null) return <LoadingState label="正在载入 AI 生成历史…" />;

  return <>
    <section className="generation-memory-actions" aria-label="教学记忆保留操作">
      <header>
        <div><h2>长期背景草案</h2><p>按班级检查已满六个月的学期快照；只有存在受控摘要时才会调用模型并生成待确认草案。</p></div>
      </header>
      <div className="generation-memory-actions__controls">
        <FormField id="generation-memory-class" label="班级">
          <Select id="generation-memory-class" value={selectedClassId} onChange={(event) => setSelectedClassId(event.target.value)} disabled={!classes.length || busyAction !== null}>
            {!classes.length && <option value="">暂无班级</option>}
            {classes.map((item) => <option key={item.id} value={item.id}>{item.name ?? item.code}</option>)}
          </Select>
        </FormField>
        <Button onClick={() => void generateDrafts()} disabled={!selectedClassId || busyAction !== null}>
          {busyAction === "draft" ? "检查并生成中…" : "生成到期长期背景草案"}
        </Button>
      </div>
      <small>确认后的内容仅在教师工作区展示，不进入家长反馈 prompt、预览或导出。</small>
      {status && <StatusBanner tone="success">{status}</StatusBanner>}
      {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    </section>

    {undoableRuns.length > 0 && <section className="generation-memory-runs" aria-label="可撤销的学期快照">
      <header><div><h2>可撤销的学期快照</h2><p>热数据转为学期快照后的 7 天内可以恢复。</p></div></header>
      {undoableRuns.map((run) => <article key={run.id}>
        <div><strong>{run.className}</strong><span>{run.affectedCount} 条记录 · {run.completedAt ? new Date(run.completedAt).toLocaleString("zh-CN") : "处理中"}</span><small>撤销期限：{new Date(run.undoUntil).toLocaleString("zh-CN")}</small></div>
        <Button variant="secondary" uiSize="sm" onClick={() => setUndoTarget(run)} disabled={busyAction !== null}>撤销压缩</Button>
      </article>)}
    </section>}

    <section className="generation-history-list" aria-label="AI 生成历史">
      {drafts.map((draft) => <article key={draft.id} className="generation-history-draft">
        <header><div><strong>{draft.scopeName} · 长期背景草案</strong><span>{new Date(draft.generatedAt).toLocaleString("zh-CN")}</span></div><Badge tone="warning">待教师确认</Badge></header>
        <Textarea value={draft.content} onChange={(event) => setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, content: event.target.value } : item))} />
        <Button uiSize="sm" onClick={() => void confirmDraft(draft)} disabled={busyAction !== null}>确认并保留长期背景</Button>
      </article>)}
      {items.map((item) => <article key={item.id}>
        <header><div><strong>{item.taskType} · {item.stage}</strong><span>{new Date(item.generatedAt).toLocaleString("zh-CN")} · {item.modelName}</span></div><Badge tone={item.lifecycle === "hot" ? "info" : item.lifecycle === "warm" ? "warning" : "neutral"}>{lifecycleLabel[item.lifecycle]}</Badge></header>
        <p>{item.lifecycle === "hot" ? "完整业务输入与结果仍在最近五课窗口内。" : item.lifecycle === "warm" ? "完整输入和成文已压缩，仅保留可追溯学期快照。" : "仅保留最小审计账本与已确认长期背景来源。"}</p>
        {item.adoptedAt && <small>已在导出或保存时采纳</small>}
      </article>)}
      {!items.length && !drafts.length && <EmptyState title="暂无 AI 生成历史" description="成功完成并通过业务校验的生成结果会出现在这里。" />}
    </section>

    <ConfirmDialog
      open={Boolean(undoTarget)}
      title="撤销学期快照压缩"
      description={undoTarget ? `将恢复 ${undoTarget.className} 的 ${undoTarget.affectedCount} 条完整生成记录。确定继续吗？` : ""}
      confirmLabel="撤销并恢复"
      warning
      busy={busyAction === "undo"}
      onConfirm={() => void undoCompaction()}
      onClose={() => { if (busyAction !== "undo") setUndoTarget(null); }}
    />
  </>;
}
