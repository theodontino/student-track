"use client";

import { useState, useEffect } from "react";

interface Student {
  id: string;
  name: string;
  class: string;
  gender: string;
}

interface Semester {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  sessionCount: number;
}

interface CardScore {
  studentId: string;
  studentName: string;
  scoreA: number;
  scoreB: number;
  scoreC: number;
  present: boolean;
  note: string;
}

const DIM_CONFIG = [
  { key: "A" as const, label: "学习", color: "bg-blue-500" },
  { key: "B" as const, label: "纪律", color: "bg-green-500" },
  { key: "C" as const, label: "作业", color: "bg-amber-500" },
];

const SCORE_COLORS = [
  "bg-red-400", "bg-red-300", "bg-orange-300",
  "bg-yellow-300", "bg-lime-400", "bg-green-400",
];

export default function QuickScorePage() {
  const [classes, setClasses] = useState<string[]>([]);
  const [allStudents, setAllStudents] = useState<Student[]>([]);
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [selectedSemesterId, setSelectedSemesterId] = useState("");
  const [selectedClass, setSelectedClass] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [cards, setCards] = useState<CardScore[]>([]);
  const [todaySessionId, setTodaySessionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recordingClass, setRecordingClass] = useState(false);
  const [result, setResult] = useState<{ count: number } | null>(null);
  const [showSemesterModal, setShowSemesterModal] = useState(false);
  const [semForm, setSemForm] = useState({ name: "", startDate: "", endDate: "" });

  useEffect(() => { fetchData(); }, []);

  async function fetchData() {
    try {
      const [studentRes, semesterRes] = await Promise.all([
        fetch("/api/students"), fetch("/api/semesters"),
      ]);
      const students: Student[] = await studentRes.json();
      const semesters: Semester[] = await semesterRes.json();
      setAllStudents(students);
      setClasses([...new Set(students.map((s) => s.class))]);
      setSemesters(semesters);
      if (semesters.length > 0) setSelectedSemesterId(semesters[0].id);
    } catch (err) { console.error(err); }
  }

  useEffect(() => {
    if (!selectedClass) { setCards([]); return; }
    const students = allStudents.filter((s) => s.class === selectedClass);
    setCards(students.map((s) => ({
      studentId: s.id, studentName: s.name,
      scoreA: 3, scoreB: 3, scoreC: 3,
      present: true, note: "",
    })));
    setResult(null);
  }, [selectedClass, allStudents]);

  async function handleRecordClass() {
    if (!selectedSemesterId) return;
    setRecordingClass(true);
    try {
      const res = await fetch(`/api/semesters/${selectedSemesterId}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ className: selectedClass || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error); return; }
      setTodaySessionId(data.id);
      await fetchData();
    } catch (err: any) { alert(err.message); }
    finally { setRecordingClass(false); }
  }

  async function createSemester() {
    if (!semForm.name || !semForm.startDate || !semForm.endDate) return;
    try {
      const res = await fetch("/api/semesters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(semForm),
      });
      if (!res.ok) throw new Error("创建失败");
      setShowSemesterModal(false);
      setSemForm({ name: "", startDate: "", endDate: "" });
      await fetchData();
    } catch (err: any) { alert(err.message); }
  }

  function setScore(idx: number, dim: "A" | "B" | "C", value: number) {
    setCards(prev => { const n = [...prev]; n[idx] = { ...n[idx], [`score${dim}`]: value }; return n; });
  }
  function togglePresent(idx: number) {
    setCards(prev => { const n = [...prev]; n[idx] = { ...n[idx], present: !n[idx].present }; return n; });
  }
  function setNote(idx: number, note: string) {
    setCards(prev => { const n = [...prev]; n[idx] = { ...n[idx], note }; return n; });
  }
  function bulkSet(dim: "A" | "B" | "C", value: number) {
    setCards(prev => prev.map(c => ({ ...c, [`score${dim}`]: value })));
  }

  async function handleSubmit() {
    const toSubmit = cards.map(c => ({
      studentId: c.studentId, date,
      scoreA: c.scoreA, scoreB: c.scoreB, scoreC: c.scoreC,
      note: c.note || undefined,
    }));
    setSubmitting(true);
    try {
      const res = await fetch("/api/quick-score", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scores: toSubmit }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);

      // Update attendance if session exists
      if (todaySessionId) {
        const ups = cards.filter(c => !c.present).map(c => ({ studentId: c.studentId, present: false }));
        if (ups.length > 0) {
          await fetch("/api/attendance", {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: todaySessionId, updates: ups }),
          });
        }
      }
    } catch (err: any) { alert(err.message); }
    finally { setSubmitting(false); }
  }

  const changedCount = cards.filter(
    c => c.scoreA !== 3 || c.scoreB !== 3 || c.scoreC !== 3 || !c.present || c.note
  ).length;
  const absentCount = cards.filter(c => !c.present).length;
  const sem = semesters.find(s => s.id === selectedSemesterId);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">快速评分</h2>
          <p className="text-sm text-gray-500 mt-1">
            卡片式批量评分 + 考勤
            {sem && <span className="text-gray-400 ml-2">| {sem.name} · 已上课 {sem.sessionCount} 次</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select value={selectedSemesterId} onChange={(e) => setSelectedSemesterId(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none"
          >
            {semesters.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
          </select>
          <button onClick={() => setShowSemesterModal(true)}
            className="border border-gray-300 text-gray-500 px-2 py-2 rounded-lg text-sm hover:bg-gray-50"
            title="新建学期"
          >+</button>
          <button onClick={handleRecordClass} disabled={recordingClass}
            className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >{recordingClass ? "..." : "🔔 上课"}</button>
          <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none"
          >
            <option value="">选择班级</option>
            {classes.map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none"
          />
        </div>
      </div>

      {selectedClass && cards.length > 0 && (
        <>
          <div className="bg-white border border-gray-200 rounded-lg p-3 mb-4 flex items-center gap-6 flex-wrap">
            <span className="text-xs font-medium text-gray-500 shrink-0">批量设置：</span>
            {DIM_CONFIG.map((dim) => (
              <div key={dim.key} className="flex items-center gap-1.5">
                <span className="text-xs text-gray-400 w-8">{dim.label}</span>
                {[0,1,2,3,4,5].map((n) => (
                  <button key={n} onClick={() => bulkSet(dim.key, n)}
                    className={`w-7 h-7 rounded text-xs font-mono font-medium border transition-colors ${
                      n <= 1 ? "border-red-200 text-red-600 hover:bg-red-50" :
                      n === 2 ? "border-orange-200 text-orange-600 hover:bg-orange-50" :
                      n === 3 ? "border-gray-200 text-gray-500 hover:bg-gray-50" :
                      "border-green-200 text-green-600 hover:bg-green-50"
                    }`}
                  >{n}</button>
                ))}
              </div>
            ))}
            <span className="text-xs text-gray-400">
              已修改 {changedCount}/{cards.length} 人
              {absentCount > 0 && <span className="text-red-500 ml-1">· {absentCount}人缺勤</span>}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-6">
            {cards.map((card, idx) => {
              const student = allStudents.find(s => s.id === card.studentId);
              const hasChange = card.scoreA !== 3 || card.scoreB !== 3 || card.scoreC !== 3;
              const hasNote = card.note.length > 0;
              return (
                <div key={card.studentId}
                  className={`bg-white rounded-lg border p-3 transition-all ${
                    hasChange || !card.present ? "border-blue-300 shadow-sm" : "border-gray-200"
                  } ${!card.present ? "ring-1 ring-red-300" : ""}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0 ${
                      student?.gender === "男" ? "bg-blue-500" : "bg-pink-500"}`}>
                      {card.studentName[0]}
                    </div>
                    <span className="text-sm font-medium text-gray-800 truncate flex-1">{card.studentName}</span>
                    <button onClick={() => togglePresent(idx)}
                      className={`text-xs px-2 py-0.5 rounded font-medium transition-colors ${
                        card.present ? "bg-green-100 text-green-700 hover:bg-red-50 hover:text-red-500"
                        : "bg-red-100 text-red-700 hover:bg-green-50 hover:text-green-500"
                      }`}
                      title={card.present ? "点击标记缺勤" : "点击标记出勤"}
                    >{card.present ? "✓ 到" : "✕ 缺"}</button>
                  </div>

                  <div className="space-y-1.5">
                    {DIM_CONFIG.map((dim) => {
                      const score = card[`score${dim.key}` as keyof CardScore] as number;
                      return (
                        <div key={dim.key} className="flex items-center gap-1">
                          <span className="text-xs text-gray-400 w-6 shrink-0">{dim.label}</span>
                          {[0,1,2,3,4,5].map((n) => (
                            <button key={n} onClick={() => setScore(idx, dim.key, n)}
                              className={`w-6 h-6 rounded text-[10px] font-mono font-medium transition-all ${
                                n === score ? `${SCORE_COLORS[n]} text-white scale-110 shadow-sm`
                                : "text-gray-300 hover:text-gray-500 hover:bg-gray-100"
                              }`}
                            >{n}</button>
                          ))}
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-2">
                    {hasNote ? (
                      <textarea value={card.note} onChange={(e) => setNote(idx, e.target.value)}
                        rows={2} placeholder="备注"
                        className="w-full border border-gray-200 rounded px-2 py-1 text-xs resize-none focus:ring-1 focus:ring-blue-300 outline-none"
                      />
                    ) : (
                      <button onClick={() => setNote(idx, " ")} className="text-xs text-gray-300 hover:text-gray-500">+ 备注</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sticky bottom-0 bg-gray-50/95 backdrop-blur border-t border-gray-200 -mx-6 -mb-6 px-6 py-4 flex items-center justify-between">
            {result ? (
              <div className="text-green-600 text-sm font-medium">✅ 已提交 {result.count} 条记录</div>
            ) : (
              <div className="text-sm text-gray-500">
                将提交 {cards.length} 名学生的评分
                {changedCount > 0 && <span className="text-blue-600 ml-1">（{changedCount} 人有变动）</span>}
              </div>
            )}
            <button onClick={handleSubmit} disabled={submitting}
              className="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >{submitting ? "提交中..." : "全部提交"}</button>
          </div>
        </>
      )}

      {selectedClass && cards.length === 0 && (
        <div className="text-center py-20 text-gray-400"><p className="text-4xl mb-3">📭</p><p>该班级暂无学生</p></div>
      )}
      {!selectedClass && (
        <div className="text-center py-20 text-gray-400"><p className="text-4xl mb-3">👆</p><p>请选择学期和班级</p></div>
      )}

      {/* Semester Creation Modal */}
      {showSemesterModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl w-full max-w-sm p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-800 mb-4">新建学期</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">学期名称</label>
                <input type="text" value={semForm.name} placeholder="如：2025-2026学年第一学期"
                  onChange={(e) => setSemForm({ ...semForm, name: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">开始日期</label>
                  <input type="date" value={semForm.startDate}
                    onChange={(e) => setSemForm({ ...semForm, startDate: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">结束日期</label>
                  <input type="date" value={semForm.endDate}
                    onChange={(e) => setSemForm({ ...semForm, endDate: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none"
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowSemesterModal(false)}
                className="flex-1 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50"
              >取消</button>
              <button onClick={createSemester}
                className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
              >创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
