"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, ConfirmDialog, EmptyState, Section, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";

type TaskType = "wecom" | "classroom-parse" | "feedback" | "daily-report";

interface CacheOperation {
  id: string;
  taskType: TaskType;
  title: string;
  status: "active" | "succeeded" | "failed" | "interrupted";
  startedAt: string;
  completedAt: string | null;
  callCount: number;
  warning: string | null;
  sizeBytes: number;
}

interface CacheOverview {
  rootLabel: string;
  totalSizeBytes: number;
  maxSizeBytes: number;
  operations: CacheOperation[];
}

const taskLabels: Record<TaskType, string> = {
  wecom: "企微提取",
  "classroom-parse": "课堂解析",
  feedback: "反馈生成",
  "daily-report": "班级日报",
};

const statusLabels = {
  active: "运行中",
  succeeded: "成功",
  failed: "失败",
  interrupted: "已中断",
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function LLMCachePanel() {
  const [data, setData] = useState<CacheOverview | null>(null);
  const [pendingTask, setPendingTask] = useState<TaskType | "all" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await requestJson<CacheOverview>("/api/system/llm-cache"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取 LLM 缓存清单失败");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function clear() {
    if (!pendingTask) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const query = pendingTask === "all" ? "" : `?taskType=${encodeURIComponent(pendingTask)}`;
      const result = await requestJson<{ removed: number }>(`/api/system/llm-cache${query}`, {
        method: "DELETE",
      });
      setStatus(`已清理 ${result.removed} 个非活动缓存操作；运行中的缓存未删除。`);
      setPendingTask(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "清理 LLM 缓存失败");
    } finally {
      setBusy(false);
    }
  }

  const tasks = [...new Set(data?.operations.map((operation) => operation.taskType) ?? [])];

  return (
    <>
      <Section
        className="llm-cache-section"
        title="LLM 本机缓存"
        description="按一次操作保存模型请求与响应，便于排查；页面只显示安全元数据，正文需在本机目录查看。"
      >
        <div className="llm-cache-toolbar">
          <div className="llm-cache-toolbar__summary">
            <Badge tone="info">{formatBytes(data?.totalSizeBytes ?? 0)} / {formatBytes(data?.maxSizeBytes ?? 0)}</Badge>
            <code>{data?.rootLabel ?? "data/llm-cache"}</code>
          </div>
          <div className="llm-cache-toolbar__actions">
            {tasks.map((task) => (
              <Button key={task} variant="secondary" uiSize="sm" disabled={busy} onClick={() => setPendingTask(task)}>清理{taskLabels[task]}</Button>
            ))}
            <Button variant="warning" uiSize="sm" disabled={!data?.operations.length || busy} onClick={() => setPendingTask("all")}>
              清理全部非活动缓存
            </Button>
          </div>
        </div>
        {status && <StatusBanner tone="success">{status}</StatusBanner>}
        {error && <StatusBanner tone="danger">{error}</StatusBanner>}
        {!data || data.operations.length === 0 ? (
          <EmptyState title="暂无 LLM 缓存" description="完成一次模型任务后会在这里显示操作级元数据。" />
        ) : (
          <div className="llm-cache-operation-grid">
            {data.operations.map((operation) => (
              <article key={operation.id} className="llm-cache-operation">
                <div className="llm-cache-operation__heading">
                  <strong>{taskLabels[operation.taskType]}</strong>
                  <Badge tone={operation.status === "succeeded" ? "success" : operation.status === "active" ? "info" : "warning"}>
                    {statusLabels[operation.status]}
                  </Badge>
                </div>
                <p>
                  {new Date(operation.startedAt).toLocaleString("zh-CN")} · {operation.callCount} 次调用 · {formatBytes(operation.sizeBytes)}
                </p>
                {operation.warning && <p className="llm-cache-operation__warning">{operation.warning}</p>}
              </article>
            ))}
          </div>
        )}
      </Section>

      <ConfirmDialog
        open={Boolean(pendingTask)}
        title="确认清理 LLM 缓存"
        description={pendingTask === "all"
          ? "将删除全部非活动操作缓存；正在运行的操作会保留。该操作不会删除数据库记录或 LM Studio 自身日志。"
          : `将删除${pendingTask ? taskLabels[pendingTask] : "所选任务"}的非活动缓存，不影响其他任务类型。`}
        confirmLabel="确认清理"
        warning
        busy={busy}
        onConfirm={() => void clear()}
        onClose={() => { if (!busy) setPendingTask(null); }}
      />
    </>
  );
}
