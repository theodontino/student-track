"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ArchiveButton from "@/components/ArchiveButton";
import { ClassDashboardOverview, StudentDashboardOverview } from "./DashboardOverview";
import type { DashboardData } from "./types";
import { ErrorState, LoadingState, PageHeader, Select } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { useTeachingContext } from "@/features/teaching-context/use-teaching-context";
import type { SemesterSummary } from "@/features/teaching-context/types";

export type DashboardView = "student" | "class";

export default function DashboardWorkspace({ view = "student" }: { view?: DashboardView }) {
  const [semesters, setSemesters] = useState<SemesterSummary[]>([]);
  const { context, hydrated, setSemesterId } = useTeachingContext();
  const selectedSemesterId = context.semesterId;
  const selectedSemesterName = selectedSemesterId
    ? semesters.find((semester) => semester.id === selectedSemesterId)?.name
    : undefined;
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const headerSemesterName = selectedSemesterName ?? data?.semester?.name;

  const fetchData = useCallback(async (semesterId: string) => {
    setLoading(true); setError("");
    try { const query = semesterId ? `?semesterId=${encodeURIComponent(semesterId)}` : ""; const dashboard = await requestJson<DashboardData>(`/api/alerts${query}`); setData(dashboard); if (!semesterId && dashboard.semester) setSemesterId(dashboard.semester.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取仪表盘失败"); }
    finally { setLoading(false); }
  }, [setSemesterId]);

  useEffect(() => {
    requestJson<SemesterSummary[]>("/api/semesters").then(setSemesters).catch(() => setSemesters([]));
  }, []);
  useEffect(() => { if (hydrated) void fetchData(selectedSemesterId); }, [fetchData, hydrated, selectedSemesterId]);

  function selectSemester(semesterId: string) {
    setSemesterId(semesterId);
  }

  const title = view === "student" ? "学生仪表" : "班级仪表";
  const description = view === "student" ? "学生警告、教师待办与学习状态" : "班级预警与四维教学概况";
  return <div className="mx-auto max-w-6xl">
    <PageHeader title={title} description={headerSemesterName ? `${headerSemesterName} · ${description}` : description} context={<label className="block min-w-48 text-xs font-semibold text-gray-500">查看学期<Select className="mt-1" value={selectedSemesterId} onChange={(event) => selectSemester(event.target.value)}><option value="">当前学期</option>{semesters.map((semester) => <option key={semester.id} value={semester.id}>{semester.name}</option>)}</Select></label>} />
    {loading ? <LoadingState label={`正在加载${title}…`} /> : error ? <ErrorState message={error} /> : data ? view === "student" ? <StudentDashboardOverview data={data} semesterId={selectedSemesterId || data.semester?.id} /> : <ClassDashboardOverview data={data} semesterId={selectedSemesterId || data.semester?.id} /> : null}
    <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-6"><ArchiveButton onSuccess={() => fetchData(selectedSemesterId)} /><Link href="/system/maintenance" className="text-xs text-gray-500 hover:text-blue-700">维护与操作日志</Link></div>
  </div>;
}
