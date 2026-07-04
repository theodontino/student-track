"use client";

import { useEffect, useState } from "react";
import type { WeComCandidatePath, WeComImportResult } from "./types";

interface WeComImportPreviewProps {
  externalJsonText?: string;
  externalFileName?: string;
  externalVersion?: number;
  onApplied?: (result: WeComImportResult) => void;
}

export default function WeComImportPreview({
  externalJsonText = "",
  externalFileName = "",
  externalVersion = 0,
  onApplied,
}: WeComImportPreviewProps) {
  const [jsonPath, setJsonPath] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [fileName, setFileName] = useState("");
  const [candidates, setCandidates] = useState<WeComCandidatePath[]>([]);
  const [includeMedium, setIncludeMedium] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WeComImportResult | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadCandidates() {
      try {
        const res = await fetch("/api/wecom/import");
        const data = await res.json();
        if (cancelled) return;
        setCandidates(data.candidates || []);
        if (data.suggestedPath && !externalJsonText) setJsonPath(data.suggestedPath);
      } catch {
        if (!cancelled) setError("读取企微 JSON 建议路径失败");
      }
    }

    void loadCandidates();
    return () => { cancelled = true; };
  }, [externalJsonText]);

  useEffect(() => {
    if (!externalVersion || !externalJsonText) return;
    setJsonText(externalJsonText);
    setJsonPath("");
    setFileName(externalFileName || "LLM 生成的企微候选 JSON");
    setResult(null);
    setError("");
    setStatus("已接收候选 JSON，可以先预览导入。");
  }, [externalFileName, externalJsonText, externalVersion]);

  async function chooseFile(file: File | undefined) {
    setResult(null);
    setStatus("");
    setError("");
    if (!file) {
      setJsonText("");
      setFileName("");
      return;
    }
    if (!file.name.endsWith(".json")) {
      setError("请上传 JSON 文件");
      return;
    }
    setFileName(file.name);
    setJsonText(await file.text());
  }

  async function runImport(apply: boolean) {
    if (apply && result && result.createCount <= 0) {
      setError("当前预览没有可新增记录");
      return;
    }
    if (apply && !confirm(`确认写入 ${result?.createCount ?? 0} 条家校沟通记录？写入前会自动备份数据库。`)) return;

    setLoading(true);
    setStatus("");
    setError("");
    try {
      const res = await fetch("/api/wecom/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonPath: jsonText ? "" : jsonPath,
          jsonText,
          includeMedium,
          apply,
        }),
      });
      const data: WeComImportResult & { error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error || "导入失败");
      setResult(data);
      setStatus(apply ? `已写入 ${data.createdCount} 条家校沟通记录。` : "预览完成，尚未写入。");
      if (apply) onApplied?.(data);
    } catch (e: any) {
      setError(e.message || "企微导入失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="bg-white border border-gray-200 rounded-lg p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-800">企微家校沟通导入</h3>
          <p className="text-sm text-gray-500 mt-1">
            从候选 JSON 预览并导入家校沟通；未知课次会绑定学生所在班级第一次课。
          </p>
        </div>
        {fileName && (
          <span className="text-xs border border-blue-100 bg-blue-50 text-blue-700 rounded px-2 py-1">
            已选择 {fileName}
          </span>
        )}
      </div>

      {candidates.length > 0 && (
        <label className="block">
          <span className="text-sm font-medium text-gray-700">最近生成的 JSON</span>
          <select
            value={jsonPath}
            onChange={(e) => {
              setJsonPath(e.target.value);
              setJsonText("");
              setFileName("");
              setResult(null);
            }}
            className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {candidates.map((item) => (
              <option key={item.path} value={item.path}>
                {item.path} · {new Date(item.modifiedAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="block">
        <span className="text-sm font-medium text-gray-700">JSON 文件路径</span>
        <input
          value={jsonPath}
          onChange={(e) => {
            setJsonPath(e.target.value);
            setJsonText("");
            setFileName("");
            setResult(null);
          }}
          className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="$HOME/.openclaw/workspace/.../chemtrack-bridge.json"
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={includeMedium}
            onChange={(e) => {
              setIncludeMedium(e.target.checked);
              setResult(null);
            }}
            className="h-4 w-4 rounded border-gray-300"
          />
          包含中等置信度学生匹配
        </label>

        <label className="inline-flex items-center gap-2 text-sm text-gray-600">
          <span className="px-3 py-2 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 cursor-pointer">
            上传 JSON
          </span>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => void chooseFile(e.target.files?.[0])}
            className="hidden"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => runImport(false)}
          disabled={loading || (!jsonPath && !jsonText)}
          className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
        >
          {loading ? "处理中..." : "预览导入"}
        </button>
        <button
          onClick={() => runImport(true)}
          disabled={loading || !result || result.createCount <= 0}
          className="px-4 py-2 rounded-md border border-green-200 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
        >
          确认写入
        </button>
      </div>

      {status && <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{status}</div>}
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

      {result && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-gray-200 text-center text-sm">
            <div className="bg-gray-50 p-3"><div className="text-xs text-gray-400">沟通候选</div><div className="font-semibold text-gray-800">{result.communicationCandidateCount}</div></div>
            <div className="bg-gray-50 p-3"><div className="text-xs text-gray-400">可入库</div><div className="font-semibold text-gray-800">{result.importableCount}</div></div>
            <div className="bg-gray-50 p-3"><div className="text-xs text-gray-400">将新增</div><div className="font-semibold text-green-700">{result.createCount}</div></div>
            <div className="bg-gray-50 p-3"><div className="text-xs text-gray-400">重复</div><div className="font-semibold text-gray-800">{result.duplicateCount}</div></div>
            <div className="bg-gray-50 p-3"><div className="text-xs text-gray-400">跳过</div><div className="font-semibold text-amber-700">{result.skippedCount}</div></div>
            <div className="bg-gray-50 p-3"><div className="text-xs text-gray-400">AI 上下文</div><div className="font-semibold text-gray-800">{result.aiContextCandidateCount}</div></div>
          </div>

          <div className="p-4 space-y-4">
            {result.backupPath && (
              <div className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-700">备份：{result.backupPath}</div>
            )}

            {result.plans.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2">可导入记录</h4>
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {result.plans.map((plan) => (
                    <div key={`${plan.student.id}-${plan.session.id}-${plan.summary}`} className="rounded-md border border-gray-200 p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mb-1">
                        <span className="font-medium text-gray-800">{plan.student.name}</span>
                        <span>{plan.student.studentId}</span>
                        <span>{plan.session.code}</span>
                        <span>{plan.binding === "first_class_session_fallback" ? "第一次课锚点" : "指定课次"}</span>
                        {plan.duplicate && <span className="text-amber-700 bg-amber-50 border border-amber-100 rounded px-1.5">重复</span>}
                      </div>
                      <p className="text-sm text-gray-700 leading-6">{plan.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.skipped.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-2">跳过项</h4>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {result.skipped.map((item, index) => (
                    <div key={`${item.title}-${index}`} className="text-sm text-gray-500">
                      {item.name || "未知学生"} / {item.title || "未知会话"}：{item.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
