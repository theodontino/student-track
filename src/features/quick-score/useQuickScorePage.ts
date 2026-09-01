"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTeachingContext } from "@/features/teaching-context/use-teaching-context";
import type { QuickScoreNotice, QuickScoreSaveResult } from "./types";
import { useQuickScoreReferenceData } from "./useQuickScoreReferenceData";
import { useQuickScoreSave } from "./useQuickScoreSave";
import { useQuickScoreSessions } from "./useQuickScoreSessions";
import { useQuickScoreWorkspace } from "./useQuickScoreWorkspace";

export function useQuickScorePage() {
  const [notice, setNotice] = useState<QuickScoreNotice | null>(null);
  const [result, setResult] = useState<QuickScoreSaveResult | null>(null);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const teachingContext = useTeachingContext();
  const { context, hydrated: contextHydrated } = teachingContext;
  const { semesterId: selectedSemesterId, className: selectedClass, classId: selectedClassId = "", sessionCode: selectedSessionCode } = context;
  const scoreCards = useQuickScoreWorkspace();
  const reference = useQuickScoreReferenceData(setNotice, selectedSemesterId || undefined);
  const session = useQuickScoreSessions({
    context,
    contextHydrated,
    students: reference.students,
    cards: scoreCards.cards,
    setContext: teachingContext.setContext,
    setSemesterId: teachingContext.setSemesterId,
    setSessionCode: teachingContext.setSessionCode,
    setCards: scoreCards.setCards,
    setOriginalScores: scoreCards.setOriginalScores,
    setResult,
    setNotice,
  });
  const save = useQuickScoreSave({
    changedCards: scoreCards.changedCards,
    date: session.date,
    sessionCode: selectedSessionCode,
    sessions: session.sessions,
    setNotice,
    setResult,
    reloadSession: session.loadSessionCards,
  });

  useEffect(() => {
    if (contextHydrated && session.workspaceHydrated && !selectedSemesterId && reference.semesters.length > 0) {
      teachingContext.setSemesterId(reference.semesters[0].id);
    }
  }, [contextHydrated, reference.semesters, selectedSemesterId, session.workspaceHydrated, teachingContext]);

  const selectedSession = session.sessions.find((item) => item.code === selectedSessionCode);
  const selectedSemester = reference.semesters.find((semester) => semester.id === selectedSemesterId);
  const genders = useMemo(() => new Map(reference.students.map((student) => [student.id, student.gender])), [reference.students]);
  const setSelectedClassId = useCallback((classId: string) => {
    const klass = reference.classes.find((item) => item.id === classId);
    teachingContext.setContext((current) => ({
      ...current,
      classId,
      className: klass?.name ?? klass?.code ?? "",
      sessionCode: "",
    }));
  }, [reference.classes, teachingContext]);

  useEffect(() => {
    if (!selectedClass || selectedClassId || reference.classes.length === 0) return;
    const matches = reference.classes.filter((klass) => klass.name === selectedClass || klass.code === selectedClass);
    if (matches.length === 1) setSelectedClassId(matches[0].id);
  }, [reference.classes, selectedClass, selectedClassId, setSelectedClassId]);

  return {
    absentCount: scoreCards.absentCount,
    bulkSet: scoreCards.bulkSet,
    cards: scoreCards.cards,
    changedCount: scoreCards.changedCount,
    classes: reference.classes,
    contextHydrated,
    date: session.date,
    deleteConfirmationOpen: session.deleteConfirmationOpen,
    deletingSession: session.deletingSession,
    genders,
    handleDeleteSession: session.deleteSession,
    handleSessionCreated: session.acceptCreatedSession,
    handleSessionChange: session.changeSession,
    handleSubmit: save.submit,
    hasExistingScores: session.hasExistingScores,
    notice,
    requestDeleteSession: session.requestDeleteSession,
    restoreHistory: session.restoreHistory,
    result,
    selectedClass,
    selectedClassId,
    selectedSemester,
    selectedSemesterId,
    selectedSession,
    selectedSessionCode,
    sessionDialogOpen,
    semesters: reference.semesters,
    sessions: session.sessions,
    setDate: session.setDate,
    setDeleteConfirmationOpen: session.setDeleteConfirmationOpen,
    setNote: scoreCards.setNote,
    setScore: scoreCards.setScore,
    setSelectedClassId,
    setSelectedSemesterId: teachingContext.setSemesterId,
    setSelectedSessionCode: teachingContext.setSessionCode,
    setSessionDialogOpen,
    setSemesters: reference.setSemesters,
    setShowSemesterModal: reference.setShowSemesterModal,
    showSemesterModal: reference.showSemesterModal,
    submitting: save.submitting,
    togglePresent: scoreCards.togglePresent,
    workspaceHydrated: session.workspaceHydrated,
  };
}
