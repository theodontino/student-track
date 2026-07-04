"use client";

import { useState } from "react";

interface WeComBridgePanelProps {
  sourceText: string;
  onSourceTextChange: (value: string) => void;
  onGenerated: (jsonText: string, fileName: string) => void;
}

export default function WeComBridgePanel({
  sourceText,
  onSourceTextChange,
  onGenerated,
}: WeComBridgePanelProps) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function generateBridge() {
    if (!sourceText.trim()) {
      setError("请先粘贴企微导出文本，或点击 WeComCatch 导出后再生成候选 JSON");
      return;
    }

    setLoading(true);
    setStatus("");
    setError("");
    try {
      const res = await fetch("/api/wecom/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "生成企微候选 JSON 失败");
      onGenerated(JSON.stringify(data.bridgeJson, null, 2), "LLM 生成的企微候选 JSON");
      setStatus("已生成企微候选 JSON，可以先预览导入。");
    } catch (e: any) {
      setError(e.message || "生成企微候选 JSON 失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
      <div>
        <h3 className="font-semibold text-gray-800">生成 Chem-Track 候选 JSON</h3>
        <p className="text-sm text-gray-500 mt-1">
          可粘贴 WeComCatch 导出内容或一段聊天记录，由当前 LLM 配置提取为家校沟通候选。
        </p>
      </div>

      <textarea
        value={sourceText}
        onChange={(e) => onSourceTextChange(e.target.value)}
        placeholder="粘贴企微导出内容或聊天记录。点击「导出记录」后，如果脚本返回文本，也会自动填入这里。"
        className="w-full min-h-[120px] rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={generateBridge}
          disabled={loading || !sourceText.trim()}
          className="px-4 py-2 rounded-md bg-amber-600 text-white text-sm font-medium disabled:opacity-50"
        >
          {loading ? "生成中..." : "生成候选 JSON"}
        </button>
        <span className="text-xs text-gray-400">{sourceText.length} 字</span>
      </div>

      {status && <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{status}</div>}
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
    </section>
  );
}
