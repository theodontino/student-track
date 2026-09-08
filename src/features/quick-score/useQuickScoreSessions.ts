"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { TeachingContext } from "@/features/teaching-context/types";
import { teachingContextWorkspaceKey } from "@/features/teaching-context/url-context";
import type { CardScore, SessionInfo } from "@/lib/types";
import { useSessionWorkspace } from "@/lib/use-session-workspace";
import { deleteQuickScoreSession, loadQuickScoreSession, loadQuickScoreSessions } from "./api";
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
import { rebaseQuickScoreCards, type ScoreField } from "./score-changes";

function today() {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function useQuickScoreSessions({
  context,
  contextHydrated,
  students,
  cards,
  originalScores,
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
  originalScores: Map<string, OriginalScore>;
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
  const [date, setDate] = useState(today);
  const [hasExistingScores, setHasExistingScores] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [legacyCards, setLegacyCards] = useState<CardScore[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const selectedKey = teachingContextWorkspaceKey("quick-score", context);
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

  const workspaceValue = useMemo<QuickScoreSessionState>(() => ({ context, date, cards, originalScores: Object.fromEntries(originalScores), legacyCards }), [cards, context, date, originalScores, legacyCards]);
  const workspaceKey = useMemo(
    () => teachingContextWorkspaceKey("quick-score", { ...context, sessionCode: "" }),
    [context],
  );
  const { hydrated: workspaceHydrated } = useSessionWorkspace({
    key: workspaceKey,
    value: workspaceValue,
    validate: isQuickScoreSessionState,
    enabled: contextHydrated,
    writeEnabled: loadedKey === selectedKey,
    restore: (saved) => {
      setLoadedKey(null);
      setLegacyCards([]);
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
        originalScores: saved.originalScores,
        legacyCards: saved.legacyCards,
      };
      setDate(saved.date);
      setCards([]);
      setResult(null);
    },
  });

  const loadSessionCards = useCallback(async (session: SessionInfo) => {
    setLoadedKey(null);
    setLoadError(false);
    sessionCodeRef.current = session.code;
    const requestId = ++cardsRequestRef.current;
    const selectedSemester = semesterRef.current;
    const selectedClass = classRef.current;
    const selectedClassId = classIdRef.current;
    setDate(session.date);
    setResult(null);
    setNotice(null);
    try {
      const data = await loadQuickScoreSession(selectedClass, session.code, selectedSemester, selectedClassId);
      if (sessionCodeRef.current !== session.code || !shouldApplyQuickScoreRequest({
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
      if (pending && pending.semesterId === selectedSemester && (pending.classId ? pending.classId === selectedClassId : pending.className === selectedClass) && pending.sessionCode === session.code) {
        setDate(pending.date);
        setCards(pending.originalScores ? rebaseQuickScoreCards(loadedCards, pending.cards, pending.originalScores) : loadedCards);
        setLegacyCards(pending.originalScores ? pending.legacyCards ?? [] : pending.cards);
        pendingRestoreRef.current = null;
      } else {
        setCards(loadedCards);
      }
      setLoadedKey(teachingContextWorkspaceKey("quick-score", { semesterId: selectedSemester, classId: selectedClassId, className: selectedClass, sessionCode: session.code }));
      return true;
    } catch (error) {
      if (sessionCodeRef.current !== session.code || !shouldApplyQuickScoreRequest({
        requestId,
        latestRequestId: cardsRequestRef.current,
        requestedSemesterId: selectedSemester,
        currentSemesterId: semesterRef.current,
        requestedClassId: selectedClassId,
        currentClassId: classIdRef.current,
        requestedClassName: selectedClass,
        currentClassName: classRef.current,
      })) return false;
      setLoadError(true);
      setNotice({ tone: "danger", message: error instanceof Error ? error.message : "加载课次评分失败" });
      return false;
    }
  }, [setCards, setNotice, setOriginalScores, setResult]);

  const initBlankCards = useCallback(() => {
    const selectedClassId = classIdRef.current;
    const classStudents = studentsRef.current.filter((student) => selectedClassId
      ? student.classId === selectedClassId
      : student.class === classRef.current);
    const blankCards = classStudents.map((student) => ({ studentId: student.id, studentName: student.name, scoreA: 3, scoreB: 3, scoreC: 3, present: true, note: "" }));
    const pending = pendingRestoreRef.current;
    setOriginalScores(new Map());
    setCards(pending?.originalScores ? rebaseQuickScoreCards(blankCards, pending.cards, pending.originalScores) : blankCards);
    setLegacyCards(pending ? pending.originalScores ? pending.legacyCards ?? [] : pending.cards : []);
    pendingRestoreRef.current = null;
    setLoadedKey(teachingContextWorkspaceKey("quick-score", { semesterId: semesterRef.current, classId: selectedClassId, className: classRef.current, sessionCode: "" }));
  }, [setCards, setOriginalScores]);

  const fetchSessions = useCallback(async () => {
    setLoadedKey(null);
    setLoadError(false);
    const requestId = ++sessionsRequestRef.current;
    // Once a newer session-list refresh starts, cards selected from an older
    // list must not be allowed to land while this refresh is still in flight.
    cardsRequestRef.current += 1;
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
        initBlankCards();
        return true;
      }
      const currentDate = today();
      const restoredCode = sessionCodeRef.current || pending?.sessionCode || "";
      const target = selectQuickScoreSession(data, restoredCode, currentDate);
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
      setLoadError(true);
      setNotice({ tone: "danger", message: error instanceof Error ? error.message : "加载课次列表失败" });
      return false;
    }
  }, [classId, className, initBlankCards, loadSessionCards, semesterId, setNotice, setSessionCode]);

  useEffect(() => {
    if (!contextHydrated || !workspaceHydrated) return;
    if (!semesterId || (!classId && !className)) {
      sessionsRequestRef.current += 1;
      cardsRequestRef.current += 1;
      setSessions([]);
      setLoadedKey(null);
      setSessionCode("");
      setCards([]);
      return;
    }
    void fetchSessions();
  }, [classId, className, contextHydrated, fetchSessions, semesterId, setCards, setSessionCode, workspaceHydrated]);

  async function changeSession(code: string) {
    setLoadedKey(null);
    setLegacyCards([]);
    pendingRestoreRef.current = null;
    sessionCodeRef.current = code;
    setSessionCode(code);
    if (!code) { cardsRequestRef.current += 1; setCards([]); return; }
    const session = sessions.find((item) => item.code === code);
    if (session) await loadSessionCards(session);
  }

  async function acceptCreatedSession(session: { code: string; date: string }) {
    // Creating a session changes the write target immediately. Invalidate every
    // older card load and clear the old session snapshot before refreshing, so
    // a failed refresh can never leave old cards attached to the new code.
    cardsRequestRef.current += 1;
    pendingRestoreRef.current = null;
    setCards([]);
    setOriginalScores(new Map());
    setHasExistingScores(false);
    setResult(null);
    setDate(session.date);
    setNotice(null);
    sessionCodeRef.current = session.code;
    setSessionCode(session.code);
    if (await fetchSessions()) setNotice({ tone: "success", message: "新课次已创建并载入。" });
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
    setLoadedKey(null);
    pendingRestoreRef.current = state;
    if (state.semesterId === semesterId && (state.classId ? state.classId === classId : state.className === className)) {
      setSessionCode(state.sessionCode);
      if (!state.sessionCode) {
        setDate(state.date);
        initBlankCards();
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
      setCards([]);
    }
  }

  return {
    loadError,
    retryLoad: fetchSessions,
    invalidateSelection: () => {
      cardsRequestRef.current += 1;
      sessionsRequestRef.current += 1;
      pendingRestoreRef.current = null;
      setLoadedKey(null);
      setLegacyCards([]);
    },
    changeDate: (nextDate: string) => {
      cardsRequestRef.current += 1;
      pendingRestoreRef.current = null;
      sessionCodeRef.current = "";
      setSessionCode("");
      setDate(nextDate);
      setResult(null);
      initBlankCards();
    },
    legacyCards,
    dismissLegacyDraft: () => setLegacyCards([]),
    restoreLegacyField: (studentId: string, field: ScoreField) => {
      if (loadedKey !== selectedKey) return;
      const draft = legacyCards.find((card) => card.studentId === studentId);
      if (draft) setCards((current) => current.map((card) => card.studentId === studentId ? { ...card, [field]: draft[field] } : card));
    },
    cardsReady: loadedKey === selectedKey,
    sessions,
    date,
    setDate,
    hasExistingScores,
    deletingSession,
    deleteConfirmationOpen,
    setDeleteConfirmationOpen,
    workspaceHydrated,
    loadSessionCards,
    changeSession,
    acceptCreatedSession,
    requestDeleteSession,
    deleteSession,
    restoreHistory,
    setSemesterId,
    setSessionCode,
  };
}
