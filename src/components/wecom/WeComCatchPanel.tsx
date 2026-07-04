"use client";

import { useState } from "react";
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

  async function run(action: WeComCatchAction) {
    if (action === "sync-start") {
      const ok = confirm("企微同步可能切换会话并改变未读状态。请确认 Mac 已解锁，并且同步期间不要调整企微窗口。");
      if (!ok) return;
    }

    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/wecomcatch/${action}`, {
        method: action === "status" || action === "sync-status" ? "GET" : "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "WeComCatch 操作失败");
      setResult(data);
      if (action === "export" && data.stdout) onExportText?.(data.stdout);
    } catch (e: any) {
      setError(e.message || "WeComCatch 操作失败");
    } finally {
      setLoading(false);
    }
  }

  return (
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
        <button
          onClick={() => run("status")}
          disabled={loading}
          className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          读取状态
        </button>
        <button
          onClick={() => run("sync-start")}
          disabled={loading}
          className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
        >
          启动同步
        </button>
        <button
          onClick={() => run("sync-status")}
          disabled={loading}
          className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          同步进度
        </button>
        <button
          onClick={() => run("export")}
          disabled={loading}
          className="px-4 py-2 rounded-md border border-green-200 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
        >
          导出记录
        </button>
      </div>

      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {result?.warning && <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">{result.warning}</div>}
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
  );
}
