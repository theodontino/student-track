"use client";

import { useCallback, useEffect, useState } from "react";
import { loadQuickScoreReferenceData } from "./api";
import type { QuickScoreClass, QuickScoreNotice, QuickScoreSemester, QuickScoreStudent } from "./types";

export function useQuickScoreReferenceData(setNotice: (notice: QuickScoreNotice | null) => void, semesterId?: string) {
  const [classes, setClasses] = useState<QuickScoreClass[]>([]);
  const [students, setStudents] = useState<QuickScoreStudent[]>([]);
  const [semesters, setSemesters] = useState<QuickScoreSemester[]>([]);
  const [showSemesterModal, setShowSemesterModal] = useState(false);

  const refresh = useCallback(async () => {
    setNotice(null);
    try {
      const data = await loadQuickScoreReferenceData(semesterId);
      setStudents(data.students);
      setClasses(data.classes);
      setSemesters(data.semesters);
    } catch (error) {
      setNotice({ tone: "danger", message: error instanceof Error ? error.message : "加载学生和学期失败" });
    }
  }, [semesterId, setNotice]);

  useEffect(() => { void refresh(); }, [refresh]);
  return { classes, students, semesters, setSemesters, showSemesterModal, setShowSemesterModal, refresh };
}
