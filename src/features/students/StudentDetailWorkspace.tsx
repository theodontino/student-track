"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";

interface StudentEvent {
  id: string;
  session: { date: string; code: string; semesterNumber: number };
  type: string;
  description: string;
  rawText: string;
}

interface StudentCommunication {
  id: string;
  session: { date: string; code: string };
  target: string;
  summary: string;
}

interface StudentAttendance {
  id: string;
  present: boolean;
  session: { date: string; semesterNumber: number; code: string };
}

interface StudentDetail {
  id: string; name: string; class: string; studentId: string;
  gender: string; labels: { id: string; name: string }[];
  sessionMetrics: { id: string; date: string; scoreA: number; scoreB: number; scoreC: number; scoreD: number }[];
  events: StudentEvent[];
  communications: StudentCommunication[];
  attendances?: StudentAttendance[];
  _pagination?: { eventHasMore: boolean; commHasMore: boolean };
}

const PAGE_SIZE = 20;
const SUMMARY_LIMIT = 3;

type DetailPanel = "events" | "communications" | "attendance";

function eventTypeClass(type: string) {
  if (type === "测验成绩") return "bg-green-100 text-green-700";
  if (type === "心理状态") return "bg-purple-100 text-purple-700";
  if (type === "家校沟通") return "bg-orange-100 text-orange-700";
  return "bg-blue-100 text-blue-700";
}

function detailPanelTitle(panel: DetailPanel) {
  if (panel === "events") return "关键事件";
  if (panel === "communications") return "家校沟通";
  return "考勤记录";
}

export default function StudentDetailWorkspace() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [student, setStudent] = useState<StudentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [trendDays, setTrendDays] = useState(30);
  const [eventOffset, setEventOffset] = useState(0);
  const [commOffset, setCommOffset] = useState(0);
  const [eventHasMore, setEventHasMore] = useState(false);
  const [commHasMore, setCommHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState<"events" | "comms" | null>(null);
  const [activePanel, setActivePanel] = useState<DetailPanel | null>(null);

  const fetchStudent = useCallback(async () => {
    try {
      const res = await fetch(`/api/students/${id}?eventLimit=${PAGE_SIZE}&eventOffset=0&commLimit=${PAGE_SIZE}&commOffset=0`);
      if (!res.ok) throw new Error("学生不存在");
      const data = await res.json();
      setEventHasMore(data._pagination?.eventHasMore ?? false);
      setCommHasMore(data._pagination?.commHasMore ?? false);
      setEventOffset(0);
      setCommOffset(0);

      const attRes = await fetch(`/api/attendance?studentId=${id}`);
      const attData = attRes.ok ? await attRes.json() : [];
      setStudent({ ...data, attendances: attData });
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void fetchStudent(); }, [fetchStudent]);

  async function loadMoreEvents() {
    const nextOffset = eventOffset + PAGE_SIZE;
    setLoadingMore("events");
    try {
      const res = await fetch(`/api/students/${id}?eventLimit=${PAGE_SIZE}&eventOffset=${nextOffset}&commLimit=0&commOffset=0`);
      if (!res.ok) throw new Error("加载事件失败");
      const data = await res.json();
      setStudent((current) => current ? { ...current, events: [...current.events, ...data.events] } : current);
      setEventHasMore(data._pagination?.eventHasMore ?? false);
      setEventOffset(nextOffset);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMore(null);
    }
  }

  async function loadMoreCommunications() {
    const nextOffset = commOffset + PAGE_SIZE;
    setLoadingMore("comms");
    try {
      const res = await fetch(`/api/students/${id}?eventLimit=0&eventOffset=0&commLimit=${PAGE_SIZE}&commOffset=${nextOffset}`);
      if (!res.ok) throw new Error("加载沟通记录失败");
      const data = await res.json();
      setStudent((current) => current ? { ...current, communications: [...current.communications, ...data.communications] } : current);
      setCommHasMore(data._pagination?.commHasMore ?? false);
      setCommOffset(nextOffset);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMore(null);
    }
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

  const latestMetric = student.sessionMetrics[0];
  const radarData = latestMetric ? [
    { dim: "学习&测验", score: latestMetric.scoreA },
    { dim: "精神&纪律", score: latestMetric.scoreB },
    { dim: "课后任务", score: latestMetric.scoreC },
    { dim: "考勤", score: latestMetric.scoreD ?? 3 },
  ] : [];

  const trendData = [...student.sessionMetrics]
    .filter((m) => {
      if (trendDays === 0) return true;
      const daysAgo = (Date.now() - new Date(m.date).getTime()) / 86400000;
      return daysAgo <= trendDays;
    })
    .reverse()
    .map((m) => ({
      date: m.date.slice(5),
      "学习&测验": m.scoreA,
      "精神&纪律": m.scoreB,
      "课后任务": m.scoreC,
      "考勤": m.scoreD ?? 3,
    }));

  // Attendance summary
  const totalSessions = student.attendances?.length ?? 0;
  const presentCount = student.attendances?.filter(a => a.present).length ?? 0;
  const absentCount = totalSessions - presentCount;
  const eventSummary = student.events.slice(0, SUMMARY_LIMIT);
  const communicationSummary = student.communications.slice(0, SUMMARY_LIMIT);
  const attendanceSummary = (student.attendances ?? []).slice(0, SUMMARY_LIMIT);

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
                <span key={l.id} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{l.name}</span>
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
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">趋势图</h3>
            <select value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))}
              className="text-xs border border-gray-300 rounded px-2 py-1 outline-none">
              <option value={7}>近 7 天</option>
              <option value={30}>近 30 天</option>
              <option value={90}>近 90 天</option>
              <option value={0}>全部</option>
            </select>
          </div>
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

      {/* Student records */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-700">关键事件</h3>
              <p className="text-xs text-gray-400 mt-1">最近 {eventSummary.length} 条 · 已载入 {student.events.length} 条</p>
            </div>
            <button data-testid="student-records-view-events" onClick={() => setActivePanel("events")} className="text-xs text-blue-600 hover:text-blue-800 shrink-0">
              查看全部
            </button>
          </div>
          {eventSummary.length > 0 ? (
            <div className="space-y-3">
              {eventSummary.map((event) => (
                <div key={event.id} className="flex gap-3 text-sm">
                  <span className="text-xs text-gray-400 shrink-0 w-20">{event.session.date}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${eventTypeClass(event.type)}`}>{event.type}</span>
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
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-700">家校沟通</h3>
              <p className="text-xs text-gray-400 mt-1">最近 {communicationSummary.length} 条 · 已载入 {student.communications.length} 条</p>
            </div>
            <button data-testid="student-records-view-communications" onClick={() => setActivePanel("communications")} className="text-xs text-blue-600 hover:text-blue-800 shrink-0">
              查看全部
            </button>
          </div>
          {communicationSummary.length > 0 ? (
            <div className="space-y-3">
              {communicationSummary.map((comm) => (
                <div key={comm.id} className="flex gap-3 text-sm">
                  <span className="text-xs text-gray-400 shrink-0 w-20">{comm.session.date}</span>
                  <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded shrink-0">{comm.target}</span>
                  <p className="text-gray-700">{comm.summary}</p>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-gray-400 text-center py-8">暂无记录</p>}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-700">考勤记录</h3>
              <p className="text-xs text-gray-400 mt-1">出勤 {presentCount}/{totalSessions} · 缺勤 {absentCount}</p>
            </div>
            <button data-testid="student-records-view-attendance" onClick={() => setActivePanel("attendance")} className="text-xs text-blue-600 hover:text-blue-800 shrink-0">
              查看全部
            </button>
          </div>
          {attendanceSummary.length > 0 ? (
            <div className="space-y-2">
              {attendanceSummary.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-sm">
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

      {activePanel && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4 py-6" onClick={() => setActivePanel(null)}>
          <div data-testid="student-records-panel" className="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-3xl max-h-[86vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs text-gray-400">{student.name} 的学生记录</p>
                <h3 className="text-lg font-semibold text-gray-800">{detailPanelTitle(activePanel)}</h3>
              </div>
              <button onClick={() => setActivePanel(null)} className="w-8 h-8 rounded-full border border-gray-200 text-gray-500 hover:text-gray-800 hover:bg-gray-50">
                ×
              </button>
            </div>

            <div className="px-5 py-3 border-b border-gray-200 flex gap-2 overflow-x-auto">
              {(["events", "communications", "attendance"] as DetailPanel[]).map((panel) => (
                <button
                  key={panel}
                  data-testid={`student-records-tab-${panel}`}
                  onClick={() => setActivePanel(panel)}
                  className={`text-sm px-3 py-1.5 rounded border shrink-0 ${
                    activePanel === panel
                      ? "border-blue-600 bg-blue-50 text-blue-700"
                      : "border-gray-200 text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  {detailPanelTitle(panel)}
                </button>
              ))}
            </div>

            <div className="p-5 overflow-y-auto">
              {activePanel === "events" && (
                <div className="space-y-3">
                  {student.events.length > 0 ? student.events.map((event) => (
                    <div key={event.id} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        <span className="text-xs text-gray-400">{event.session.date}</span>
                        <span className="text-xs text-gray-400">第{event.session.semesterNumber}课</span>
                        <span className="text-xs text-gray-400">{event.session.code}</span>
                        <span className={`text-xs px-2 py-0.5 rounded ${eventTypeClass(event.type)}`}>{event.type}</span>
                      </div>
                      <p className="text-sm text-gray-800 leading-6">{event.description}</p>
                      {event.rawText && (
                        <div className="mt-3 bg-gray-50 border border-gray-100 rounded-lg p-3">
                          <p className="text-xs text-gray-400 mb-1">原始片段</p>
                          <p className="text-sm text-gray-600 leading-6">{event.rawText}</p>
                        </div>
                      )}
                    </div>
                  )) : (
                    <p className="text-sm text-gray-400 text-center py-12">暂无事件</p>
                  )}
                  {eventHasMore && (
                    <button onClick={loadMoreEvents} disabled={loadingMore === "events"}
                      className="w-full text-sm text-blue-600 hover:text-blue-800 py-2 rounded-lg hover:bg-blue-50 disabled:opacity-50">
                      {loadingMore === "events" ? "加载中..." : "加载更多事件"}
                    </button>
                  )}
                </div>
              )}

              {activePanel === "communications" && (
                <div className="space-y-3">
                  {student.communications.length > 0 ? student.communications.map((comm) => (
                    <div key={comm.id} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        <span className="text-xs text-gray-400">{comm.session.date}</span>
                        <span className="text-xs text-gray-400">{comm.session.code}</span>
                        <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">{comm.target}</span>
                      </div>
                      <p className="text-sm text-gray-800 leading-6">{comm.summary}</p>
                    </div>
                  )) : (
                    <p className="text-sm text-gray-400 text-center py-12">暂无家校沟通记录</p>
                  )}
                  {commHasMore && (
                    <button onClick={loadMoreCommunications} disabled={loadingMore === "comms"}
                      className="w-full text-sm text-blue-600 hover:text-blue-800 py-2 rounded-lg hover:bg-blue-50 disabled:opacity-50">
                      {loadingMore === "comms" ? "加载中..." : "加载更多沟通记录"}
                    </button>
                  )}
                </div>
              )}

              {activePanel === "attendance" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="border border-gray-200 rounded-lg p-3">
                      <p className="text-xs text-gray-400">总记录</p>
                      <p className="text-lg font-semibold text-gray-800">{totalSessions}</p>
                    </div>
                    <div className="border border-gray-200 rounded-lg p-3">
                      <p className="text-xs text-gray-400">出勤</p>
                      <p className="text-lg font-semibold text-green-700">{presentCount}</p>
                    </div>
                    <div className="border border-gray-200 rounded-lg p-3">
                      <p className="text-xs text-gray-400">缺勤</p>
                      <p className="text-lg font-semibold text-red-700">{absentCount}</p>
                    </div>
                  </div>
                  {(student.attendances ?? []).length > 0 ? (
                    <div className="space-y-2">
                      {(student.attendances ?? []).map((attendance) => (
                        <div key={attendance.id} className="border border-gray-200 rounded-lg p-3 flex flex-wrap items-center gap-3">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                            attendance.present ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                          }`}>
                            {attendance.present ? "出勤" : "缺勤"}
                          </span>
                          <span className="text-sm text-gray-700">第{attendance.session.semesterNumber}课</span>
                          <span className="text-sm text-gray-500">{attendance.session.date}</span>
                          <span className="text-xs text-gray-400">{attendance.session.code}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400 text-center py-12">暂无考勤记录</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
