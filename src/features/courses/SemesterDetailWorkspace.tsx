"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";

interface Session {
  id: string;
  code: string;
  date: string;
  semesterNumber: number;
  class: { code: string; name: string | null } | null;
  _count: { attendances: number };
}

interface SemesterDetail {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  sessions: Session[];
  sessionCount: number;
  totalStudents: number;
  attendances: number;
}

export default function SemesterDetailWorkspace() {
  const params = useParams();
  const [semester, setSemester] = useState<SemesterDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/semesters/${params.id}`)
      .then((r) => r.json())
      .then(setSemester)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [params.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        加载中...
      </div>
    );
  }

  if (!semester) {
    return <div className="text-center py-20 text-gray-400">学期不存在</div>;
  }

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-1">{semester.name}</h2>
      <p className="text-sm text-gray-500 mb-6">
        {semester.startDate} → {semester.endDate}
      </p>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="text-3xl font-bold text-blue-600">{semester.sessionCount}</div>
          <div className="text-sm text-gray-500 mt-1">课次总数</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="text-3xl font-bold text-green-600">{semester.totalStudents}</div>
          <div className="text-sm text-gray-500 mt-1">学生总数</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="text-3xl font-bold text-purple-600">{semester.attendances}</div>
          <div className="text-sm text-gray-500 mt-1">考勤记录总数</div>
        </div>
      </div>

      {/* Session list */}
      <h3 className="text-lg font-semibold text-gray-800 mb-3">课次列表</h3>
      {semester.sessions.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">
          暂无课次记录
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-500">课次编码</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">日期</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">学期序号</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">班级</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">考勤人数</th>
              </tr>
            </thead>
            <tbody>
              {semester.sessions.map((s) => (
                <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-blue-600">{s.code}</td>
                  <td className="px-4 py-3 text-gray-700">{s.date}</td>
                  <td className="px-4 py-3 text-gray-700">第 {s.semesterNumber} 次</td>
                  <td className="px-4 py-3 text-gray-700">
                    {s.class ? (s.class.name ?? s.class.code) : "全校"}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">{s._count.attendances}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
