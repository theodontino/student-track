"use client";

import { useState } from "react";
import { Button, ConfirmDialog, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import type { WeComCatchResult } from "./types";

type WeComCatchAction = "status" | "sync-start" | "sync-status" | "export";

interface WeComCatchPanelProps {
  onExportText?: (text: string) => void;
  showFeedbackLink?: boolean;
}

function formatOutput(result: WeComCatchResult | null) {
  if (!result) return "";
  if (result.parsed) return JSON.stringify(result.parsed, null, 2);
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

export default function WeComCatchPanel({ onExportText, showFeedbackLink = false }: WeComCatchPanelProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WeComCatchResult | null>(null);
  const [error, setError] = useState("");
  const [syncConfirmationOpen, setSyncConfirmationOpen] = useState(false);

  async function run(action: WeComCatchAction) {
    setLoading(true);
    setError("");
    try {
      const data = await requestJson<WeComCatchResult>(`/api/wecomcatch/${action}`, {
        method: action === "status" || action === "sync-status" ? "GET" : "POST",
      });
      setResult(data);
      if (action === "export" && data.stdout) onExportText?.(data.stdout);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "WeComCatch 操作失败");
    } finally {
      setLoading(false);
    }
  }

  function requestRun(action: WeComCatchAction) {
    if (action === "sync-start") {
      setSyncConfirmationOpen(true);
      return;
    }
    void run(action);
  }

  return (
    <>
      <section className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-800">WeComCatch 手动同步</h3>
          <p className="text-sm text-gray-500 mt-1">
            只通过固定 wrapper 脚本读取状态、启动同步和导出记录；不会自动同步企微。
          </p>
        </div>
        {showFeedbackLink && (
          <a href="/feedback" className="text-sm text-blue-600 hover:text-blue-700">去课后反馈工作台</a>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          onClick={() => requestRun("status")}
          disabled={loading}
        >
          读取状态
        </Button>
        <Button
          onClick={() => requestRun("sync-start")}
          disabled={loading}
        >
          启动同步
        </Button>
        <Button
          variant="secondary"
          onClick={() => requestRun("sync-status")}
          disabled={loading}
        >
          同步进度
        </Button>
        <Button
          variant="secondary"
          onClick={() => requestRun("export")}
          disabled={loading}
        >
          导出记录
        </Button>
      </div>

      {error && <StatusBanner tone="danger">{error}</StatusBanner>}
      {result?.warning && <StatusBanner tone="warning">{result.warning}</StatusBanner>}
      {result && (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          <div className="bg-gray-50 px-3 py-2 text-xs text-gray-500">
            {result.command} · {result.scriptPath}
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap p-3 text-xs text-gray-700">
            {formatOutput(result) || "命令已执行，无输出。"}
          </pre>
        </div>
      )}
      </section>
      <ConfirmDialog
        open={syncConfirmationOpen}
        title="启动企微同步"
        description="企微同步可能切换会话并改变未读状态。请确认 Mac 已解锁，并且同步期间不要调整企微窗口。"
        confirmLabel="启动同步"
        busy={loading}
        onConfirm={() => {
          setSyncConfirmationOpen(false);
          void run("sync-start");
        }}
        onClose={() => setSyncConfirmationOpen(false)}
      />
    </>
  );
}
