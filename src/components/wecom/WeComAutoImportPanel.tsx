"use client";

import { useState } from "react";
import { Button, ConfirmDialog, StatusBanner } from "@/components/ui";
import type { WeComImportResult } from "./types";

interface ProgressEvent {
  type: "progress";
  progress: number;
  message: string;
  detail?: string;
}

interface CompleteEvent {
  type: "complete";
  result: WeComImportResult;
  conversationCount: number;
  messageCount: number;
  batchCount: number;
}

interface WeComAutoImportPanelProps {
  onApplied?: (result: WeComImportResult) => void;
}

export default function WeComAutoImportPanel({ onApplied }: WeComAutoImportPanelProps) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [complete, setComplete] = useState<CompleteEvent | null>(null);

  async function startImport() {
    setConfirmationOpen(false);
    setRunning(true);
    setProgress(1);
    setMessage("正在启动…");
    setDetail("");
    setError("");
    setComplete(null);

    try {
      const response = await fetch("/api/wecom/auto-import", { method: "POST" });
      if (!response.ok || !response.body) throw new Error("无法启动企微一键导入");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ProgressEvent | CompleteEvent | { type: "error"; message: string };
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "progress") {
            setProgress(event.progress);
            setMessage(event.message);
            setDetail(event.detail || "");
          } else {
            setComplete(event);
            onApplied?.(event.result);
          }
        }
        if (done) break;
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "企微一键导入失败");
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <section className="min-w-0 rounded-lg border border-blue-200 bg-blue-50 p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h3 className="font-semibold text-gray-800">一键同步并导入</h3>
            <p className="mt-1 text-sm leading-6 text-gray-600">
              自动拉取企微聊天，只把未处理的新消息交给 LLM；每批独立写入并记录可回滚变更。
            </p>
          </div>
          <Button onClick={() => setConfirmationOpen(true)} disabled={running}>
            {running ? "处理中…" : "一键同步并导入"}
          </Button>
        </div>

        {(running || progress > 0) && (
          <div className="space-y-2" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium text-gray-700">{message}</span>
              <span className="shrink-0 tabular-nums text-gray-500">{progress}%</span>
            </div>
            <div
              className="h-2.5 overflow-hidden rounded-full bg-blue-100"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-label={message || "企微导入进度"}
            >
              <div className="h-full rounded-full bg-blue-600 transition-[width] duration-500" style={{ width: `${progress}%` }} />
            </div>
            {detail && <p className="text-xs text-gray-500">{detail}</p>}
          </div>
        )}

        {error && <StatusBanner tone="danger">{error}；已成功批次不会重复调用 LLM，可从失败批次继续。</StatusBanner>}
        {complete && (
          <StatusBanner tone="success">
            处理 {complete.conversationCount} 个会话、{complete.messageCount} 条新消息，写入 {complete.result.createdCount} 条家校沟通，
            新增 {complete.result.createdLabelCount} 个内部关注标签。
          </StatusBanner>
        )}
      </section>

      <ConfirmDialog
        open={confirmationOpen}
        title="一键同步并导入企微记录"
        description="该操作会自动操作企微窗口，可能改变未读状态；筛选后的聊天内容会发送给当前配置的 LLM。请确保 Mac 已解锁，处理期间不要操作企微。"
        confirmLabel="开始处理"
        busy={running}
        onConfirm={() => void startImport()}
        onClose={() => setConfirmationOpen(false)}
      />
    </>
  );
}
