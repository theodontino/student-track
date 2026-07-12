"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  LocalToolAvailability,
  LocalToolsStatusResponse,
} from "@/lib/local-tool-status";

const STATUS_LABEL: Record<LocalToolAvailability, string> = {
  available: "可用",
  warning: "警告",
  unavailable: "不可用",
};

const STATUS_STYLE: Record<LocalToolAvailability, string> = {
  available: "border-green-200 bg-green-50 text-green-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  unavailable: "border-red-200 bg-red-50 text-red-700",
};

export default function LocalToolStatusPanel() {
  const [data, setData] = useState<LocalToolsStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/system/local-tools", { cache: "no-store" });
      if (!response.ok) throw new Error("本地工具自检失败");
      setData(await response.json());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "本地工具自检失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5" aria-labelledby="local-tools-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="local-tools-title" className="font-semibold text-gray-800">本地工具状态</h3>
          <p className="mt-1 text-sm text-gray-500">只读检查路径和文件，不会安装依赖、启动同步或读取聊天内容。</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? "检查中..." : "重新检查"}
        </button>
      </div>

      <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        音频转写使用 auto 模式时会依次尝试通义听悟、本地 FunASR 和阿里云 ASR，音频可能上传到云端。
      </div>

      {error && (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      {loading && !data ? (
        <p className="mt-4 text-sm text-gray-500" aria-live="polite">正在检查本地工具...</p>
      ) : (
        <div className="mt-4 space-y-4" aria-live="polite">
          {data?.tools.map((tool) => (
            <div key={tool.id} className="rounded-md border border-gray-200 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="font-medium text-gray-800">{tool.name}</h4>
                <span className={`rounded border px-2 py-0.5 text-xs ${STATUS_STYLE[tool.status]}`}>
                  {STATUS_LABEL[tool.status]}
                </span>
                <span className="text-xs text-gray-500">{tool.summary}</span>
              </div>
              {tool.notice && <p className="mt-2 text-xs text-amber-700">{tool.notice}</p>}
              <div className="mt-3 divide-y divide-gray-100">
                {tool.checks.map((item) => (
                  <div key={item.id} className="grid gap-1 py-2 text-sm md:grid-cols-[150px_90px_1fr]">
                    <span className="font-medium text-gray-700">{item.label}</span>
                    <span className={item.status === "available" ? "text-green-700" : item.status === "warning" ? "text-amber-700" : "text-red-700"}>
                      {STATUS_LABEL[item.status]}
                    </span>
                    <div className="min-w-0 text-gray-500">
                      <div>{item.detail}</div>
                      {item.path && <div className="mt-0.5 break-all font-mono text-xs text-gray-400">{item.path}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {data && (
        <p className="mt-3 text-xs text-gray-400">
          上次检查：{new Date(data.checkedAt).toLocaleString()}
        </p>
      )}
    </section>
  );
}
