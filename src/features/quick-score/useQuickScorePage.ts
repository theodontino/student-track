"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveWorkHistory } from "@/lib/history";
import type { SessionInfo } from "@/lib/types";
import { useSessionWorkspace } from "@/lib/use-session-workspace";
import {
  teachingContextWorkspaceKey,
  useTeachingContext,
} from "@/features/teaching-context";
import type {
  QuickScoreHistoryState,
  QuickScoreSaveResult,
  QuickScoreSemester,
  QuickScoreSessionState,
  QuickScoreStudent,
} from "./types";
import { useQuickScoreWorkspace } from "./useQuickScoreWorkspace";
import { isQuickScoreSessionState } from "./workspace-state";

type ScoreItem = {
  studentId: string;
  scoreA: number;
  scoreB: number;
  scoreC: number;
  present: boolean;
};

export function useQuickScorePage() {
  const [classes, setClasses] = useState<string[]>([]);
  const [allStudents, setAllStudents] = useState<QuickScoreStudent[]>([]);
  const [semesters, setSemesters] = useState<QuickScoreSemester[]>([]);
  const {
    context,
    hydrated: contextHydrated,
    setContext,
    setSemesterId: setSelectedSemesterId,
    setClassName: setSelectedClass,
    setSessionCode: setSelectedSessionCode,
  } = useTeachingContext();
  const {
    semesterId: selectedSemesterId,
    className: selectedClass,
    sessionCode: selectedSessionCode,
  } = context;
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const scoreCards = useQuickScoreWorkspace();
  const {
    cards,
    setCards,
    setOriginalScores,
    changedCards,
    changedCount,
    absentCount,
    setScore,
    togglePresent,
    setNote,
    bulkSet,
  } = scoreCards;
  const [submitting, setSubmitting] = useState(false);
  const [recordingClass, setRecordingClass] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);
  const [result, setResult] = useState<QuickScoreSaveResult | null>(null);
  const [hasExistingScores, setHasExistingScores] = useState(false);
  const [showSemesterModal, setShowSemesterModal] = useState(false);

  const selectedClassRef = useRef(selectedClass);
  const selectedSessionCodeRef = useRef(selectedSessionCode);
  const allStudentsRef = useRef(allStudents);
  const pendingRestoreRef = useRef<QuickScoreHistoryState | null>(null);

  useEffect(() => {
    selectedClassRef.current = selectedClass;
    selectedSessionCodeRef.current = selectedSessionCode;
    allStudentsRef.current = allStudents;
  }, [allStudents, selectedClass, selectedSessionCode]);

  const workspaceValue = useMemo<QuickScoreSessionState>(
    () => ({ context, date, cards }),
    [cards, context, date],
  );
  const { hydrated: workspaceHydrated } = useSessionWorkspace({
    key: teachingContextWorkspaceKey("quick-score", context),
    value: workspaceValue,
    validate: isQuickScoreSessionState,
    enabled: contextHydrated,
    restore: (saved) => {
      if (!saved) {
        pendingRestoreRef.current = null;
        setOriginalScores(new Map());
        setCards([]);
        setResult(null);
        return;
      }
      pendingRestoreRef.current = {
        semesterId: saved.context.semesterId,
        className: saved.context.className,
        sessionCode: saved.context.sessionCode,
        date: saved.date,
        cards: saved.cards,
      };
      setDate(saved.date);
      setCards(saved.cards);
      setResult(null);
    },
  });

  const fetchData = useCallback(async () => {
    try {
      const [studentRes, semesterRes] = await Promise.all([
        fetch("/api/students"),
        fetch("/api/semesters"),
      ]);
      const students: QuickScoreStudent[] = await studentRes.json();
      const semesterItems: QuickScoreSemester[] = await semesterRes.json();
      setAllStudents(students);
      setClasses([...new Set(students.map((student) => student.class))]);
      setSemesters(semesterItems);
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (contextHydrated && workspaceHydrated && !selectedSemesterId && semesters.length > 0) {
      setSelectedSemesterId(semesters[0].id);
    }
  }, [contextHydrated, semesters, selectedSemesterId, setSelectedSemesterId, workspaceHydrated]);

  const loadSessionCards = useCallback(async (session: SessionInfo) => {
    const className = selectedClassRef.current;
    const students = allStudentsRef.current.filter((student) => student.class === className);

    setDate(session.date);
    setResult(null);

    try {
      const params = new URLSearchParams({ class: className, sessionCode: session.code });
      const response = await fetch(`/api/quick-score?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      const scoresData = data.scores as ScoreItem[];
      const scoreMap = new Map<string, ScoreItem>(scoresData.map((score) => [score.studentId, score]));
      setOriginalScores(new Map(
        scoresData.map((score) => [score.studentId, {
          scoreA: score.scoreA,
          scoreB: score.scoreB,
          scoreC: score.scoreC,
          present: score.present,
        }] as const),
      ));
      setHasExistingScores(scoresData.some(
        (score) => score.scoreA !== 3 || score.scoreB !== 3 || score.scoreC !== 3,
      ));

      const loadedCards = students.map((student) => {
        const existing = scoreMap.get(student.id);
        return {
          studentId: student.id,
          studentName: student.name,
          scoreA: existing?.scoreA ?? 3,
          scoreB: existing?.scoreB ?? 3,
          scoreC: existing?.scoreC ?? 3,
          present: existing?.present ?? true,
          note: "",
        };
      });
      const pending = pendingRestoreRef.current;
      if (pending && pending.className === className && pending.sessionCode === session.code) {
        setDate(pending.date);
        setCards(pending.cards);
        pendingRestoreRef.current = null;
      } else {
        setCards(loadedCards);
      }
    } catch (error) {
      console.error("loadSessionCards error:", error);
    }
  }, [setCards, setOriginalScores]);

  const initBlankCards = useCallback(() => {
    const students = allStudentsRef.current.filter(
      (student) => student.class === selectedClassRef.current,
    );
    setCards(students.map((student) => ({
      studentId: student.id,
      studentName: student.name,
      scoreA: 3,
      scoreB: 3,
      scoreC: 3,
      present: true,
      note: "",
    })));
  }, [setCards]);

  const fetchSessions = useCallback(async () => {
    try {
      const url = `/api/sessions?semesterId=${selectedSemesterId}&className=${encodeURIComponent(selectedClass)}`;
      const response = await fetch(url);
      const data: SessionInfo[] = await response.json();
      setSessions(data);

      const pending = pendingRestoreRef.current;
      if (pending && !pending.sessionCode) {
        setSelectedSessionCode("");
        setDate(pending.date);
        setOriginalScores(new Map());
        setCards(pending.cards);
        pendingRestoreRef.current = null;
        return;
      }

      const today = new Date().toISOString().split("T")[0];
      const restoredCode = pending?.sessionCode || selectedSessionCodeRef.current;
      const restoredSession = restoredCode
        ? data.find((session) => session.code === restoredCode)
        : null;
      const todaySession = data.find((session) => session.date === today);
      const target = restoredSession || todaySession || (data.length > 0 ? data[0] : null);

      if (target) {
        setSelectedSessionCode(target.code);
        await loadSessionCards(target);
      } else {
        setSelectedSessionCode("");
        initBlankCards();
      }
    } catch (error) {
      console.error(error);
    }
  }, [
    initBlankCards,
    loadSessionCards,
    selectedClass,
    selectedSemesterId,
    setCards,
    setOriginalScores,
    setSelectedSessionCode,
  ]);

  useEffect(() => {
    if (!contextHydrated || !workspaceHydrated) return;
    if (!selectedSemesterId || !selectedClass) {
      setSessions([]);
      setSelectedSessionCode("");
      setCards([]);
      return;
    }
    void fetchSessions();
  }, [
    contextHydrated,
    fetchSessions,
    selectedClass,
    selectedSemesterId,
    setCards,
    setSelectedSessionCode,
    workspaceHydrated,
  ]);

  async function handleSessionChange(code: string) {
    setSelectedSessionCode(code);
    if (!code) {
      setCards([]);
      return;
    }
    const session = sessions.find((item) => item.code === code);
    if (session) await loadSessionCards(session);
  }

  async function handleRecordClass() {
    if (!selectedSemesterId) return;
    setRecordingClass(true);
    try {
      const response = await fetch(`/api/semesters/${selectedSemesterId}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ className: selectedClass || undefined }),
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error);
        return;
      }
      await fetchSessions();
    } catch (error) {
      alert(error instanceof Error ? error.message : "创建课次失败");
    } finally {
      setRecordingClass(false);
    }
  }

  async function handleDeleteSession() {
    if (!selectedSessionCode) return;
    if (!confirm(`确定删除课次 ${selectedSessionCode}？\n这将同时删除所有考勤记录并重算分数。`)) return;
    setDeletingSession(true);
    try {
      const response = await fetch(
        `/api/semesters/${selectedSemesterId}/session?code=${selectedSessionCode}`,
        { method: "DELETE" },
      );
      const data = await response.json();
      if (!response.ok) {
        alert(data.error);
        return;
      }
      await fetchSessions();
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除课次失败");
    } finally {
      setDeletingSession(false);
    }
  }

  async function handleSubmit() {
    if (changedCards.length === 0) {
      alert("没有改动，无需提交");
      return;
    }
    const scores = changedCards.map((card) => ({
      studentId: card.studentId,
      date,
      scoreA: card.scoreA,
      scoreB: card.scoreB,
      scoreC: card.scoreC,
      note: card.note || undefined,
    }));
    const attendances = changedCards.map((card) => ({
      studentId: card.studentId,
      present: card.present,
    }));

    setSubmitting(true);
    try {
      const response = await fetch("/api/quick-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scores,
          sessionCode: selectedSessionCode || undefined,
          attendances,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setResult(data);
      try {
        await saveWorkHistory(
          "quick-score",
          `${selectedClass} ${selectedSessionCode || date} 手动评分`,
          {
            semesterId: selectedSemesterId,
            className: selectedClass,
            sessionCode: selectedSessionCode,
            date,
            cards,
          },
          selectedSessionCode || date,
        );
      } catch (historyError) {
        console.error("save quick-score history failed:", historyError);
      }
      if (selectedSessionCode) {
        const session = sessions.find((item) => item.code === selectedSessionCode);
        if (session) await loadSessionCards(session);
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

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
    setContext({
      semesterId: state.semesterId,
      className: state.className,
      sessionCode: state.sessionCode,
    });
    setDate(state.date);
    setResult(null);
    if (!state.sessionCode) {
      setCards(state.cards);
      pendingRestoreRef.current = null;
    }
  }

  const selectedSession = sessions.find((session) => session.code === selectedSessionCode);
  const selectedSemester = semesters.find((semester) => semester.id === selectedSemesterId);
  const genders = useMemo(
    () => new Map(allStudents.map((student) => [student.id, student.gender])),
    [allStudents],
  );

  return {
    absentCount,
    bulkSet,
    cards,
    changedCount,
    classes,
    contextHydrated,
    date,
    deletingSession,
    genders,
    handleDeleteSession,
    handleRecordClass,
    handleSessionChange,
    handleSubmit,
    hasExistingScores,
    recordingClass,
    restoreHistory,
    result,
    selectedClass,
    selectedSemester,
    selectedSemesterId,
    selectedSession,
    selectedSessionCode,
    semesters,
    sessions,
    setDate,
    setNote,
    setScore,
    setSelectedClass,
    setSelectedSemesterId,
    setSelectedSessionCode,
    setSemesters,
    setShowSemesterModal,
    showSemesterModal,
    submitting,
    togglePresent,
    workspaceHydrated,
  };
}
