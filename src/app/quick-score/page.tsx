"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { SessionInfo, CardScore } from "@/lib/types";
import { DIM_CONFIG, SCORE_COLORS } from "@/lib/constants";
import WorkHistoryButton from "@/components/WorkHistoryButton";
import { saveWorkHistory } from "@/lib/history";

interface Student { id: string; name: string; class: string; gender: string; }
interface Semester { id: string; name: string; startDate: string; endDate: string; sessionCount: number; }
interface QuickScoreHistoryState {
  semesterId: string;
  className: string;
  sessionCode: string;
  date: string;
  cards: CardScore[];
}

export default function QuickScorePage() {
  const [classes, setClasses] = useState<string[]>([]);
  const [allStudents, setAllStudents] = useState<Student[]>([]);
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [selectedSemesterId, setSelectedSemesterId] = useState("");
  const [selectedClass, setSelectedClass] = useState("");
  const [selectedSessionCode, setSelectedSessionCode] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [cards, setCards] = useState<CardScore[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [recordingClass, setRecordingClass] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);
  const [result, setResult] = useState<{ count: number; attUpdated: number } | null>(null);
  const [hasExistingScores, setHasExistingScores] = useState(false); // v0.6: score history warning
  const [showSemesterModal, setShowSemesterModal] = useState(false);
  const [semForm, setSemForm] = useState({ name: "", startDate: "", endDate: "" });

  // Refs to avoid closure staleness in async callbacks
  const selectedClassRef = useRef(selectedClass);
  const allStudentsRef = useRef(allStudents);
  const originalScoresRef = useRef<Map<string, { scoreA: number; scoreB: number; scoreC: number; present: boolean }>>(new Map());
  const pendingRestoreRef = useRef<QuickScoreHistoryState | null>(null);
  selectedClassRef.current = selectedClass;
  allStudentsRef.current = allStudents;

  // --- Init ---
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

  const loadSessionCards = useCallback(async (session: SessionInfo) => {
    const cls = selectedClassRef.current;
    const students = allStudentsRef.current.filter((s) => s.class === cls);

    setDate(session.date);
    setResult(null);

    try {
      const params = new URLSearchParams({
        class: cls,
        sessionCode: session.code,
      });
      const res = await fetch(`/api/quick-score?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      type ScoreItem = { studentId: string; scoreA: number; scoreB: number; scoreC: number; present: boolean };
      const scoresData = data.scores as ScoreItem[];
      const scoreMap = new Map<string, ScoreItem>(scoresData.map((s) => [s.studentId, s]));
      originalScoresRef.current = new Map(
        scoresData.map(s => [s.studentId, { scoreA: s.scoreA, scoreB: s.scoreB, scoreC: s.scoreC, present: s.present }] as const)
      );

      const existingCount = scoresData.filter(
        (s: ScoreItem) => s.scoreA !== 3 || s.scoreB !== 3 || s.scoreC !== 3
      ).length;
      setHasExistingScores(existingCount > 0);

      const loadedCards = students.map((s) => {
        const existing = scoreMap.get(s.id);
        return {
          studentId: s.id, studentName: s.name,
          scoreA: existing?.scoreA ?? 3, scoreB: existing?.scoreB ?? 3, scoreC: existing?.scoreC ?? 3,
          present: existing?.present ?? true, note: "",
        };
      });
      const pending = pendingRestoreRef.current;
      if (pending && pending.className === cls && pending.sessionCode === session.code) {
        setDate(pending.date);
        setCards(pending.cards);
        pendingRestoreRef.current = null;
      } else {
        setCards(loadedCards);
      }
    } catch (err) { console.error("loadSessionCards error:", err); }
  }, []);

  const initBlankCards = useCallback(() => {
    const students = allStudentsRef.current.filter((s) => s.class === selectedClassRef.current);
    setCards(students.map((s) => ({
      studentId: s.id, studentName: s.name,
      scoreA: 3, scoreB: 3, scoreC: 3,
      present: true, note: "",
    })));
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const url = `/api/sessions?semesterId=${selectedSemesterId}&className=${encodeURIComponent(selectedClass)}`;
      const res = await fetch(url);
      const data: SessionInfo[] = await res.json();
      setSessions(data);

      const today = new Date().toISOString().split("T")[0];
      const restoredCode = pendingRestoreRef.current?.sessionCode;
      const restoredSession = restoredCode ? data.find((s) => s.code === restoredCode) : null;
      const todaySession = data.find((s) => s.date === today);
      const target = restoredSession || todaySession || (data.length > 0 ? data[0] : null);

      if (target) {
        setSelectedSessionCode(target.code);
        await loadSessionCards(target);
      } else {
        setSelectedSessionCode("");
        initBlankCards();
      }
    } catch (err) { console.error(err); }
  }, [initBlankCards, loadSessionCards, selectedClass, selectedSemesterId]);

  // --- When semester+class change → load sessions ---
  useEffect(() => {
    if (!selectedSemesterId || !selectedClass) {
      setSessions([]);
      setSelectedSessionCode("");
      setCards([]);
      return;
    }
    void fetchSessions();
  }, [fetchSessions, selectedSemesterId, selectedClass]);

  // --- Session change handler (dropdown onChange) ---
  async function handleSessionChange(code: string) {
    setSelectedSessionCode(code);
    if (!code) { setCards([]); return; }
    const session = sessions.find((s) => s.code === code);
    if (session) await loadSessionCards(session);
  }

  // --- Actions ---
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
      await fetchSessions(); // auto-selects + loads cards
    } catch (err: any) { alert(err.message); }
    finally { setRecordingClass(false); }
  }

  async function handleDeleteSession() {
    if (!selectedSessionCode) return;
    if (!confirm(`确定删除课次 ${selectedSessionCode}？\n这将同时删除所有考勤记录并重算分数。`)) return;
    setDeletingSession(true);
    try {
      const res = await fetch(
        `/api/semesters/${selectedSemesterId}/session?code=${selectedSessionCode}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) { alert(data.error); return; }
      await fetchSessions();
    } catch (err: any) { alert(err.message); }
    finally { setDeletingSession(false); }
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
    const originals = originalScoresRef.current;
    const changedCards = cards.filter(c => {
      const orig = originals.get(c.studentId);
      if (!orig) {
        // New card — submit if anything differs from default
        return c.scoreA !== 3 || c.scoreB !== 3 || c.scoreC !== 3 || !c.present || c.note;
      }
      return c.scoreA !== orig.scoreA || c.scoreB !== orig.scoreB || c.scoreC !== orig.scoreC
          || c.present !== orig.present || !!c.note;
    });

    if (changedCards.length === 0) { alert("没有改动，无需提交"); return; }

    const toSubmit = changedCards.map(c => ({
      studentId: c.studentId, date,
      scoreA: c.scoreA, scoreB: c.scoreB, scoreC: c.scoreC,
      note: c.note || undefined,
    }));
    const attendances = changedCards.map(c => ({
      studentId: c.studentId, present: c.present,
    }));

    setSubmitting(true);
    try {
      const res = await fetch("/api/quick-score", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scores: toSubmit,
          sessionCode: selectedSessionCode || undefined,
          attendances,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);
      try {
        await saveWorkHistory(
          "quick-score",
          `${selectedClass} ${selectedSessionCode || date} 快速评分`,
          { semesterId: selectedSemesterId, className: selectedClass, sessionCode: selectedSessionCode, date, cards },
          selectedSessionCode || date
        );
      } catch (historyError) { console.error("save quick-score history failed:", historyError); }
      // Refresh cards after submit
      if (selectedSessionCode) {
        const ses = sessions.find((s) => s.code === selectedSessionCode);
        if (ses) await loadSessionCards(ses);
      }
    } catch (err: any) { alert(err.message); }
    finally { setSubmitting(false); }
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

  // --- Derived ---
  const selectedSession = sessions.find((s) => s.code === selectedSessionCode);
  const changedCount = cards.filter(c => {
    const orig = originalScoresRef.current.get(c.studentId);
    if (!orig) return c.scoreA !== 3 || c.scoreB !== 3 || c.scoreC !== 3 || !c.present || c.note;
    return c.scoreA !== orig.scoreA || c.scoreB !== orig.scoreB || c.scoreC !== orig.scoreC
        || c.present !== orig.present || !!c.note;
  }).length;
  const absentCount = cards.filter(c => !c.present).length;
  const sem = semesters.find(s => s.id === selectedSemesterId);

  function restoreHistory(state: QuickScoreHistoryState) {
    pendingRestoreRef.current = state;
    if (state.semesterId === selectedSemesterId && state.className === selectedClass) {
      setSelectedSessionCode(state.sessionCode);
      if (!state.sessionCode) {
        setDate(state.date);
        setCards(state.cards);
        setResult(null);
        pendingRestoreRef.current = null;
        return;
      }
      const session = sessions.find((item) => item.code === state.sessionCode);
      if (session) {
        setResult(null);
        void loadSessionCards(session);
        return;
      }
    }
    setSelectedSemesterId(state.semesterId);
    setSelectedClass(state.className);
    setSelectedSessionCode(state.sessionCode);
    setDate(state.date);
    setResult(null);
    if (!state.sessionCode) {
      setCards(state.cards);
      pendingRestoreRef.current = null;
    }
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">快速评分</h2>
          <p className="text-sm text-gray-500 mt-1">
            卡片式批量评分 + 考勤
            {sem && <span className="text-gray-400 ml-2">| {sem.name} · 已上课 {sem.sessionCount} 次</span>}
          </p>
        </div>
        <WorkHistoryButton<QuickScoreHistoryState> module="quick-score" onRestore={restoreHistory} />
      </div>

      {/* Control Bar — Row 1: 学期 + 班级 + 课次 */}
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        {/* Semester */}
        <select value={selectedSemesterId} onChange={(e) => setSelectedSemesterId(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none"
        >
          {semesters.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
        </select>
        <button onClick={() => setShowSemesterModal(true)}
          className="border border-gray-300 text-gray-500 px-2 py-2 rounded-lg text-sm hover:bg-gray-50"
          title="新建学期"
        >+</button>

        {/* Class */}
        <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none"
        >
          <option value="">选择班级</option>
          {classes.map((c) => (<option key={c} value={c}>{c}</option>))}
        </select>

        {/* Session selector */}
        {selectedClass && sessions.length > 0 && (
          <>
            <span className="text-xs text-gray-400">课次</span>
            <select
              value={selectedSessionCode}
              onChange={(e) => handleSessionChange(e.target.value)}
              className="border border-blue-300 rounded-lg px-3 py-2 text-sm font-mono outline-none bg-blue-50"
            >
              {sessions.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} — 第{s.semesterNumber}次课
                </option>
              ))}
            </select>
          </>
        )}

        {/* Actions */}
        {selectedSessionCode && (
          <button onClick={handleDeleteSession} disabled={deletingSession}
            className="border border-red-200 text-red-600 px-3 py-2 rounded-lg text-sm hover:bg-red-50 disabled:opacity-50"
            title="删除当前课次"
          >{deletingSession ? "..." : "🗑"}</button>
        )}

        <button onClick={handleRecordClass} disabled={recordingClass || !selectedSemesterId || !selectedClass}
          className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
        >{recordingClass ? "..." : "🔔 上课"}</button>
      </div>

      {/* Control Bar — Row 2: date + session info */}
      {selectedSession && (
        <div className="flex items-center gap-3 mb-4 text-xs text-gray-500">
          <span>日期</span>
          <input type="date" value={date}
            onChange={(e) => { setDate(e.target.value); setSelectedSessionCode(""); }}
            className="border border-gray-300 rounded px-2 py-1 text-xs outline-none"
          />
          <span className="text-gray-400">
            学期内第 {selectedSession.semesterNumber} 次课
            {selectedSession.class && <span className="ml-1">· {selectedSession.class}</span>}
            <span className="ml-1">· 考勤 {selectedSession.attendanceCount} 人</span>
          </span>
          {/* v0.6: existing score warning */}
          {hasExistingScores && (
            <span className="text-amber-600 text-xs font-medium">⚠ 已有评分记录，提交将覆盖</span>
          )}
        </div>
      )}

      {/* Score Cards */}
      {selectedClass && cards.length > 0 && (
        <>
          {/* Batch controls */}
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

          {/* Cards grid */}
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

          {/* Bottom bar */}
          <div className="sticky bottom-0 bg-gray-50/95 backdrop-blur border-t border-gray-200 -mx-6 -mb-6 px-6 py-4 flex items-center justify-between">
            {result ? (
              <div className="text-green-600 text-sm font-medium">
                ✅ 已提交 {result.count} 条评分
                {result.attUpdated > 0 && <span className="ml-1">· 更新 {result.attUpdated} 条考勤</span>}
              </div>
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

      {/* Empty states */}
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
