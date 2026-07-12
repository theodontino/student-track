"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ArchiveButton from "@/components/ArchiveButton";
import DashboardOverview, { type DashboardData } from "@/components/DashboardOverview";

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function fetchData() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/alerts");
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "读取仪表盘失败");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取仪表盘失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void fetchData(); }, []);

  if (loading) return <div className="flex h-64 items-center justify-center text-sm text-gray-400">正在加载仪表盘...</div>;
  if (error) return <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">仪表盘</h2>
          {data.semester && <p className="mt-1 text-sm text-gray-500">{data.semester.name} · 当前学期</p>}
        </div>
        <Link href="/past-overview" className="text-sm font-medium text-blue-600 hover:text-blue-700">查看往期回顾 →</Link>
      </div>

      <DashboardOverview data={data} showFeedbackShortcut />

      <div className="mt-10 border-t border-gray-200 pt-6">
        <div className="mb-4 flex items-center justify-between">
          <ArchiveButton onSuccess={fetchData} />
          <Link href="/system-logs" className="text-xs text-gray-400 transition-colors hover:text-blue-600">操作日志</Link>
        </div>
        <p className="mt-2 text-xs text-gray-300">定期运行 <code className="rounded bg-gray-100 px-1">npm run db:maintain</code> 保持数据库健康</p>
      </div>
    </div>
  );
}
