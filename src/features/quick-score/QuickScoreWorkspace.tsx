"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { SessionInfo, CardScore } from "@/lib/types";
import WorkHistoryButton from "@/components/WorkHistoryButton";
import { saveWorkHistory } from "@/lib/history";
import { SemesterDialog } from "@/features/courses";
import BulkScoreToolbar from "./BulkScoreToolbar";
import StudentScoreGrid from "./StudentScoreGrid";
import SaveBar from "./SaveBar";
import { useQuickScoreWorkspace } from "./useQuickScoreWorkspace";
import ContextHeader from "./ContextHeader";

interface Student { id: string; name: string; class: string; gender: string; }
interface Semester { id: string; name: string; startDate: string; endDate: string; sessionCount: number; }
interface QuickScoreHistoryState {
  semesterId: string;
  className: string;
  sessionCode: string;
  date: string;
  cards: CardScore[];
}

export default function QuickScoreWorkspace() {
  const [classes, setClasses] = useState<string[]>([]);
  const [allStudents, setAllStudents] = useState<Student[]>([]);
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [selectedSemesterId, setSelectedSemesterId] = useState("");
  const [selectedClass, setSelectedClass] = useState("");
  const [selectedSessionCode, setSelectedSessionCode] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const { cards, setCards, setOriginalScores, changedCards, changedCount, absentCount, setScore, togglePresent, setNote, bulkSet } = useQuickScoreWorkspace();
  const [submitting, setSubmitting] = useState(false);
  const [recordingClass, setRecordingClass] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);
  const [result, setResult] = useState<{ count: number; attUpdated: number } | null>(null);
  const [hasExistingScores, setHasExistingScores] = useState(false); // v0.6: score history warning
  const [showSemesterModal, setShowSemesterModal] = useState(false);

  // Refs to avoid closure staleness in async callbacks
  const selectedClassRef = useRef(selectedClass);
  const allStudentsRef = useRef(allStudents);
  const pendingRestoreRef = useRef<QuickScoreHistoryState | null>(null);
  useEffect(() => { selectedClassRef.current = selectedClass; allStudentsRef.current = allStudents; }, [allStudents, selectedClass]);

  // --- Init ---
  const fetchData = useCallback(async () => {
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
  }, []);
  useEffect(() => { void fetchData(); }, [fetchData]);

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
      setOriginalScores(new Map(
        scoresData.map(s => [s.studentId, { scoreA: s.scoreA, scoreB: s.scoreB, scoreC: s.scoreC, present: s.present }] as const)
      ));

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
  }, [setCards, setOriginalScores]);

  const initBlankCards = useCallback(() => {
    const students = allStudentsRef.current.filter((s) => s.class === selectedClassRef.current);
    setCards(students.map((s) => ({
      studentId: s.id, studentName: s.name,
      scoreA: 3, scoreB: 3, scoreC: 3,
      present: true, note: "",
    })));
  }, [setCards]);

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
  }, [fetchSessions, selectedSemesterId, selectedClass, setCards]);

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
    } catch (err: unknown) { alert(err instanceof Error ? err.message : "创建课次失败"); }
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
    } catch (err: unknown) { alert(err instanceof Error ? err.message : "删除课次失败"); }
    finally { setDeletingSession(false); }
  }

  async function handleSubmit() {
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
          `${selectedClass} ${selectedSessionCode || date} 手动评分`,
          { semesterId: selectedSemesterId, className: selectedClass, sessionCode: selectedSessionCode, date, cards },
          selectedSessionCode || date
        );
      } catch (historyError) { console.error("save quick-score history failed:", historyError); }
      // Refresh cards after submit
      if (selectedSessionCode) {
        const ses = sessions.find((s) => s.code === selectedSessionCode);
        if (ses) await loadSessionCards(ses);
      }
    } catch (err: unknown) { alert(err instanceof Error ? err.message : "提交失败"); }
    finally { setSubmitting(false); }
  }

  // --- Derived ---
  const selectedSession = sessions.find((s) => s.code === selectedSessionCode);
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
      <ContextHeader semesterName={sem?.name} sessionCount={sem?.sessionCount} history={<WorkHistoryButton<QuickScoreHistoryState> module="quick-score" onRestore={restoreHistory} />}>
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
      </ContextHeader>

      {/* Score Cards */}
      {selectedClass && cards.length > 0 && (
        <>
          {/* Batch controls */}
          <BulkScoreToolbar cards={cards} changedCount={changedCount} absentCount={absentCount} onSet={bulkSet} />

          <StudentScoreGrid cards={cards} genders={new Map(allStudents.map((student) => [student.id, student.gender]))} onScore={setScore} onPresent={togglePresent} onNote={setNote} />
          <SaveBar total={cards.length} changed={changedCount} submitting={submitting} result={result} onSave={handleSubmit} />
        </>
      )}

      {/* Empty states */}
      {selectedClass && cards.length === 0 && (
        <div className="text-center py-20 text-gray-400"><p className="text-4xl mb-3">📭</p><p>该班级暂无学生</p></div>
      )}
      {!selectedClass && (
        <div className="text-center py-20 text-gray-400"><p className="text-4xl mb-3">👆</p><p>请选择学期和班级</p></div>
      )}

      <SemesterDialog open={showSemesterModal} onClose={() => setShowSemesterModal(false)} onSaved={(semester) => { setSemesters((current) => [semester as Semester, ...current]); setSelectedSemesterId(semester.id); }} />
    </div>
  );
}
