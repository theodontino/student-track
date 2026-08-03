"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { TeachingContext } from "@/features/teaching-context/types";
import { teachingContextWorkspaceKey } from "@/features/teaching-context/url-context";
import type { CardScore, SessionInfo } from "@/lib/types";
import { useSessionWorkspace } from "@/lib/use-session-workspace";
import { createQuickScoreSession, deleteQuickScoreSession, loadQuickScoreSession, loadQuickScoreSessions } from "./api";
import { selectQuickScoreSession, shouldApplyQuickScoreRequest } from "./session-helpers";
import type { OriginalScore } from "./useQuickScoreWorkspace";
import type {
  QuickScoreHistoryState,
  QuickScoreNotice,
  QuickScoreSaveResult,
  QuickScoreSessionState,
  QuickScoreStudent,
} from "./types";
import { isQuickScoreSessionState } from "./workspace-state";

export function useQuickScoreSessions({
  context,
  contextHydrated,
  students,
  cards,
  setContext,
  setSemesterId,
  setSessionCode,
  setCards,
  setOriginalScores,
  setResult,
  setNotice,
}: {
  context: TeachingContext;
  contextHydrated: boolean;
  students: QuickScoreStudent[];
  cards: CardScore[];
  setContext: (context: TeachingContext) => void;
  setSemesterId: (semesterId: string) => void;
  setSessionCode: (sessionCode: string) => void;
  setCards: Dispatch<SetStateAction<CardScore[]>>;
  setOriginalScores: Dispatch<SetStateAction<Map<string, OriginalScore>>>;
  setResult: Dispatch<SetStateAction<QuickScoreSaveResult | null>>;
  setNotice: Dispatch<SetStateAction<QuickScoreNotice | null>>;
}) {
  const { semesterId, className, classId = "", sessionCode } = context;
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [hasExistingScores, setHasExistingScores] = useState(false);
  const [recordingClass, setRecordingClass] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const semesterRef = useRef(semesterId);
  const classRef = useRef(className);
  const classIdRef = useRef(classId);
  const sessionCodeRef = useRef(sessionCode);
  const studentsRef = useRef(students);
  const pendingRestoreRef = useRef<QuickScoreHistoryState | null>(null);
  const sessionsRequestRef = useRef(0);
  const cardsRequestRef = useRef(0);

  useEffect(() => {
    semesterRef.current = semesterId;
    classRef.current = className;
    classIdRef.current = classId;
    sessionCodeRef.current = sessionCode;
    studentsRef.current = students;
  }, [classId, className, semesterId, sessionCode, students]);

  const workspaceValue = useMemo<QuickScoreSessionState>(() => ({ context, date, cards }), [cards, context, date]);
  const workspaceKey = useMemo(
    () => teachingContextWorkspaceKey("quick-score", { ...context, sessionCode: "" }),
    [context],
  );
  const { hydrated: workspaceHydrated } = useSessionWorkspace({
    key: workspaceKey,
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
        classId: saved.context.classId,
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

  const loadSessionCards = useCallback(async (session: SessionInfo) => {
    const requestId = ++cardsRequestRef.current;
    const selectedSemester = semesterRef.current;
    const selectedClass = classRef.current;
    const selectedClassId = classIdRef.current;
    setDate(session.date);
    setResult(null);
    setNotice(null);
    try {
      const data = await loadQuickScoreSession(selectedClass, session.code, selectedSemester, selectedClassId);
      if (!shouldApplyQuickScoreRequest({
        requestId,
        latestRequestId: cardsRequestRef.current,
        requestedSemesterId: selectedSemester,
        currentSemesterId: semesterRef.current,
        requestedClassId: selectedClassId,
        currentClassId: classIdRef.current,
        requestedClassName: selectedClass,
        currentClassName: classRef.current,
      })) return false;
      setOriginalScores(new Map(data.scores.map((score) => [score.studentId, {
        scoreA: score.scoreA,
        scoreB: score.scoreB,
        scoreC: score.scoreC,
        present: score.present,
      }] as const)));
      setHasExistingScores(data.scores.some((score) => score.scoreA !== 3 || score.scoreB !== 3 || score.scoreC !== 3));
      const loadedCards = data.scores.map((existing) => {
        return {
          studentId: existing.studentId,
          studentName: existing.studentName,
          scoreA: existing.scoreA,
          scoreB: existing.scoreB,
          scoreC: existing.scoreC,
          present: existing.present,
          note: "",
        };
      });
      const pending = pendingRestoreRef.current;
      if (pending && (pending.classId ? pending.classId === selectedClassId : pending.className === selectedClass) && pending.sessionCode === session.code) {
        setDate(pending.date);
        setCards(pending.cards);
        pendingRestoreRef.current = null;
      } else {
        setCards(loadedCards);
      }
      return true;
    } catch (error) {
      if (!shouldApplyQuickScoreRequest({
        requestId,
        latestRequestId: cardsRequestRef.current,
        requestedSemesterId: selectedSemester,
        currentSemesterId: semesterRef.current,
        requestedClassId: selectedClassId,
        currentClassId: classIdRef.current,
        requestedClassName: selectedClass,
        currentClassName: classRef.current,
      })) return false;
      setNotice({ tone: "danger", message: error instanceof Error ? error.message : "加载课次评分失败" });
      return false;
    }
  }, [setCards, setNotice, setOriginalScores, setResult]);

  const initBlankCards = useCallback(() => {
    const selectedClassId = classIdRef.current;
    const classStudents = studentsRef.current.filter((student) => selectedClassId
      ? student.classId === selectedClassId
      : student.class === classRef.current);
    setCards(classStudents.map((student) => ({ studentId: student.id, studentName: student.name, scoreA: 3, scoreB: 3, scoreC: 3, present: true, note: "" })));
  }, [setCards]);

  const fetchSessions = useCallback(async () => {
    const requestId = ++sessionsRequestRef.current;
    const requestedSemesterId = semesterId;
    const requestedClassName = className;
    const requestedClassId = classId;
    setNotice(null);
    try {
      const data = await loadQuickScoreSessions(semesterId, className, classId || undefined);
      if (!shouldApplyQuickScoreRequest({
        requestId,
        latestRequestId: sessionsRequestRef.current,
        requestedSemesterId,
        currentSemesterId: semesterRef.current,
        requestedClassId,
        currentClassId: classIdRef.current,
        requestedClassName,
        currentClassName: classRef.current,
      })) return false;
      setSessions(data);
      const pending = pendingRestoreRef.current;
      if (pending && !pending.sessionCode) {
        setSessionCode("");
        setDate(pending.date);
        setOriginalScores(new Map());
        setCards(pending.cards);
        pendingRestoreRef.current = null;
        return true;
      }
      const today = new Date().toISOString().split("T")[0];
      const restoredCode = pending?.sessionCode || sessionCodeRef.current;
      const target = selectQuickScoreSession(data, restoredCode, today);
      if (target) {
        setSessionCode(target.code);
        return loadSessionCards(target);
      }
      setSessionCode("");
      initBlankCards();
      return true;
    } catch (error) {
      if (!shouldApplyQuickScoreRequest({
        requestId,
        latestRequestId: sessionsRequestRef.current,
        requestedSemesterId,
        currentSemesterId: semesterRef.current,
        requestedClassId,
        currentClassId: classIdRef.current,
        requestedClassName,
        currentClassName: classRef.current,
      })) return false;
      setNotice({ tone: "danger", message: error instanceof Error ? error.message : "加载课次列表失败" });
      return false;
    }
  }, [classId, className, initBlankCards, loadSessionCards, semesterId, setCards, setNotice, setOriginalScores, setSessionCode]);

  useEffect(() => {
    if (!contextHydrated || !workspaceHydrated) return;
    if (!semesterId || (!classId && !className)) {
      sessionsRequestRef.current += 1;
      cardsRequestRef.current += 1;
      setSessions([]);
      setSessionCode("");
      setCards([]);
      return;
    }
    void fetchSessions();
  }, [classId, className, contextHydrated, fetchSessions, semesterId, setCards, setSessionCode, workspaceHydrated]);

  async function changeSession(code: string) {
    setSessionCode(code);
    if (!code) { cardsRequestRef.current += 1; setCards([]); return; }
    const session = sessions.find((item) => item.code === code);
    if (session) await loadSessionCards(session);
  }

  async function createSession() {
    if (!semesterId) return;
    setRecordingClass(true);
    setNotice(null);
    try {
      await createQuickScoreSession(semesterId, className, classId || undefined);
      if (await fetchSessions()) setNotice({ tone: "success", message: "新课次已创建并载入。" });
    } catch (error) {
      setNotice({ tone: "danger", message: error instanceof Error ? error.message : "创建课次失败" });
    } finally {
      setRecordingClass(false);
    }
  }

  function requestDeleteSession() {
    if (sessionCode) setDeleteConfirmationOpen(true);
  }

  async function deleteSession() {
    if (!sessionCode) return;
    setDeleteConfirmationOpen(false);
    setDeletingSession(true);
    setNotice(null);
    try {
      await deleteQuickScoreSession(semesterId, sessionCode);
      if (await fetchSessions()) setNotice({ tone: "success", message: "课次已删除，相关考勤和评分已按现有规则更新。" });
    } catch (error) {
      setNotice({ tone: "danger", message: error instanceof Error ? error.message : "删除课次失败" });
    } finally {
      setDeletingSession(false);
    }
  }

  function restoreHistory(state: QuickScoreHistoryState) {
    pendingRestoreRef.current = state;
    if (state.semesterId === semesterId && (state.classId ? state.classId === classId : state.className === className)) {
      setSessionCode(state.sessionCode);
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
    setContext({ semesterId: state.semesterId, classId: state.classId ?? "", className: state.className, sessionCode: state.sessionCode });
    setDate(state.date);
    setResult(null);
    if (!state.sessionCode) {
      setCards(state.cards);
      pendingRestoreRef.current = null;
    }
  }

  return {
    sessions,
    date,
    setDate,
    hasExistingScores,
    recordingClass,
    deletingSession,
    deleteConfirmationOpen,
    setDeleteConfirmationOpen,
    workspaceHydrated,
    loadSessionCards,
    changeSession,
    createSession,
    requestDeleteSession,
    deleteSession,
    restoreHistory,
    setSemesterId,
    setSessionCode,
  };
}
