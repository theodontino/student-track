"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import DashboardOverview, { type DashboardData } from "@/components/DashboardOverview";

interface SemesterOption {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  sessionCount: number;
}

export default function PastOverviewPage() {
  const [semesters, setSemesters] = useState<SemesterOption[]>([]);
  const [currentSemesterId, setCurrentSemesterId] = useState("");
  const [selectedSemesterId, setSelectedSemesterId] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const pastSemesters = useMemo(() => semesters
    .filter((semester) => semester.id !== currentSemesterId && semester.sessionCount > 0)
    .sort((left, right) => right.startDate.localeCompare(left.startDate)), [semesters, currentSemesterId]);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      setLoading(true);
      setError("");
      try {
        const [semesterResponse, currentResponse] = await Promise.all([fetch("/api/semesters"), fetch("/api/alerts")]);
        const semesterData = await semesterResponse.json();
        const currentData = await currentResponse.json();
        if (!semesterResponse.ok) throw new Error(semesterData.error || "读取学期失败");
        if (!currentResponse.ok) throw new Error(currentData.error || "读取当前学期失败");
        if (cancelled) return;
        setSemesters(semesterData);
        setCurrentSemesterId(currentData.semester?.id ?? "");
        const options = (semesterData as SemesterOption[])
          .filter((semester) => semester.id !== currentData.semester?.id && semester.sessionCount > 0)
          .sort((left, right) => right.startDate.localeCompare(left.startDate));
        setSelectedSemesterId(options[0]?.id ?? "");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "读取往期学期失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedSemesterId) {
      setData(null);
      return;
    }
    let cancelled = false;
    async function loadDashboard() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/alerts?semesterId=${encodeURIComponent(selectedSemesterId)}`);
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "读取往期回顾失败");
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "读取往期回顾失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadDashboard();
    return () => { cancelled = true; };
  }, [selectedSemesterId]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">往期回顾</h2>
          <p className="mt-1 text-sm text-gray-500">每次只查看一个学期，评分、班级和预警不会跨学期混算。</p>
        </div>
        <Link href="/" className="text-sm font-medium text-blue-600 hover:text-blue-700">返回当前仪表盘</Link>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <label htmlFor="past-semester" className="text-sm font-medium text-gray-700">回顾学期</label>
        <select
          id="past-semester"
          value={selectedSemesterId}
          onChange={(event) => setSelectedSemesterId(event.target.value)}
          disabled={pastSemesters.length === 0}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none disabled:bg-gray-100"
        >
          {pastSemesters.length === 0 && <option value="">暂无往期学期</option>}
          {pastSemesters.map((semester) => <option key={semester.id} value={semester.id}>{semester.name}</option>)}
        </select>
        {data?.semester && <span className="text-xs text-gray-400">{data.semester.startDate} 至 {data.semester.endDate}</span>}
      </div>

      {loading && <div className="py-16 text-center text-sm text-gray-400">正在加载往期数据...</div>}
      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}
      {!loading && !error && data && <DashboardOverview data={data} />}
      {!loading && !error && pastSemesters.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-10 text-center text-gray-400">暂无可回顾的往期学期</div>
      )}
    </div>
  );
}
