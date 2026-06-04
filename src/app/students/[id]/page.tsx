"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";

interface StudentDetail {
  id: string; name: string; class: string; studentId: string;
  gender: string; labels: string[];
  metrics: { id: string; date: string; scoreA: number; scoreB: number; scoreC: number; scoreD: number }[];
  events: { id: string; date: string; type: string; description: string; rawText: string }[];
  communications: { id: string; date: string; target: string; summary: string }[];
  attendances?: { id: string; present: boolean; session: { date: string; semesterNumber: number; code: string } }[];
}

export default function StudentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [student, setStudent] = useState<StudentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchStudent(); }, [id]);

  async function fetchStudent() {
    try {
      const res = await fetch(`/api/students/${id}`);
      if (!res.ok) throw new Error("学生不存在");
      const data = await res.json();

      // Fetch attendance separately
      const attRes = await fetch(`/api/attendance?studentId=${id}`);
      const attData = attRes.ok ? await attRes.json() : [];
      setStudent({ ...data, attendances: attData });
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin h-8 w-8 border-2 border-blue-600 border-t-transparent rounded-full" />
    </div>
  );
  if (!student) return (
    <div className="text-center py-20 text-gray-400">
      <p className="text-4xl mb-3">😕</p><p>学生不存在</p>
      <button onClick={() => router.push("/students")} className="text-blue-600 hover:underline mt-2">返回学生列表</button>
    </div>
  );

  const latestMetric = student.metrics[0];
  const radarData = latestMetric ? [
    { dim: "学习&测验", score: latestMetric.scoreA },
    { dim: "精神&纪律", score: latestMetric.scoreB },
    { dim: "课后任务", score: latestMetric.scoreC },
    { dim: "考勤", score: latestMetric.scoreD ?? 3 },
  ] : [];

  const trendData = [...student.metrics].reverse().map((m) => ({
    date: m.date.slice(5),
    "学习&测验": m.scoreA,
    "精神&纪律": m.scoreB,
    "课后任务": m.scoreC,
    "考勤": m.scoreD ?? 3,
  }));

  // Attendance summary
  const totalSessions = student.attendances?.length ?? 0;
  const presentCount = student.attendances?.filter(a => a.present).length ?? 0;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <button onClick={() => router.push("/students")} className="text-sm text-gray-500 hover:text-gray-700">← 返回学生列表</button>
      </div>

      <div className="flex items-start gap-4 mb-8">
        <div className={`w-14 h-14 rounded-full flex items-center justify-center text-white text-xl font-bold shrink-0 ${
          student.gender === "男" ? "bg-blue-500" : "bg-pink-500"}`}>
          {student.name[0]}
        </div>
        <div>
          <h2 className="text-2xl font-bold text-gray-800">{student.name}</h2>
          <p className="text-sm text-gray-500">{student.class} · {student.studentId}</p>
          <div className="flex items-center gap-3 mt-2">
            <div className="flex flex-wrap gap-1">
              {student.labels.map((l) => (
                <span key={l} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{l}</span>
              ))}
            </div>
            <span className="text-xs text-gray-400">
              出勤 {presentCount}/{totalSessions} · D={latestMetric?.scoreD ?? "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">当前四维得分</h3>
          {radarData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <RadarChart data={radarData}>
                <PolarGrid />
                <PolarAngleAxis dataKey="dim" fontSize={12} />
                <PolarRadiusAxis angle={30} domain={[0, 5]} tickCount={6} fontSize={11} />
                <Radar name="得分" dataKey="score" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.2} />
              </RadarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-64 text-gray-400 text-sm">暂无评分数据</div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">30天趋势</h3>
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" fontSize={11} />
                <YAxis domain={[0, 5]} tickCount={6} fontSize={11} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="学习&测验" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="精神&纪律" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="课后任务" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="考勤" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} strokeDasharray="5 5" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-64 text-gray-400 text-sm">暂无历史数据</div>
          )}
        </div>
      </div>

      {/* Events, Communications, Attendance */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">关键事件</h3>
          {student.events.length > 0 ? (
            <div className="space-y-3">
              {student.events.map((event) => (
                <div key={event.id} className="flex gap-3 text-sm">
                  <span className="text-xs text-gray-400 shrink-0 w-20">{event.date}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                    event.type === "测验成绩" ? "bg-green-100 text-green-700" :
                    event.type === "心理状态" ? "bg-purple-100 text-purple-700" :
                    event.type === "家校沟通" ? "bg-orange-100 text-orange-700" :
                    "bg-blue-100 text-blue-700"
                  }`}>{event.type}</span>
                  <div className="flex-1">
                    <p className="text-gray-700">{event.description}</p>
                    <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{event.rawText}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-gray-400 text-center py-8">暂无事件</p>}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">家校沟通</h3>
          {student.communications.length > 0 ? (
            <div className="space-y-3">
              {student.communications.map((comm) => (
                <div key={comm.id} className="flex gap-3 text-sm">
                  <span className="text-xs text-gray-400 shrink-0 w-20">{comm.date}</span>
                  <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded shrink-0">{comm.target}</span>
                  <p className="text-gray-700">{comm.summary}</p>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-gray-400 text-center py-8">暂无记录</p>}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">考勤记录</h3>
          {student.attendances && student.attendances.length > 0 ? (
            <div className="space-y-2">
              {student.attendances.map((a, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className={`text-xs font-mono font-medium px-1.5 py-0.5 rounded ${
                    a.present ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}>
                    {a.present ? "✓" : "✕"}
                  </span>
                  <span className="text-xs text-gray-400">第{a.session.semesterNumber}课</span>
                  <span className="text-xs text-gray-400">{a.session.date}</span>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-gray-400 text-center py-8">暂无记录</p>}
        </div>
      </div>
    </div>
  );
}
