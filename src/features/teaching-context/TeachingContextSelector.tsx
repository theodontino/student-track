"use client";

import { useEffect } from "react";
import { Select } from "@/components/ui";
import { useClasses, useSemesters, useSessions } from "./use-options";
import type { TeachingContext } from "./types";

export function TeachingContextSelector({ value, onChange, hideSession = false, refreshKey = 0, compact = false }: { value: TeachingContext; onChange: (value: TeachingContext) => void; hideSession?: boolean; refreshKey?: number; compact?: boolean }) {
  const semesters = useSemesters(refreshKey); const classes = useClasses(value.semesterId, refreshKey);
  const selectedClass = classes.find((klass) => klass.id === value.classId || klass.code === value.className || klass.name === value.className);
  const selectedClassId = selectedClass?.id ?? value.classId ?? "";
  const sessions = useSessions(value.semesterId, selectedClassId, value.className, refreshKey);
  useEffect(() => {
    if (value.classId || !selectedClass) return;
    onChange({
      ...value,
      classId: selectedClass.id,
      className: selectedClass.name ?? selectedClass.code,
    });
  }, [onChange, selectedClass, value]);
  return <div className={`teaching-context-selector ${compact ? "is-compact" : ""}`}>
    <label><span>学期</span><Select value={value.semesterId} onChange={(event) => onChange({ semesterId: event.target.value, className: "", classId: "", sessionCode: "" })}><option value="">选择学期</option>{semesters.map((semester) => <option key={semester.id} value={semester.id}>{semester.name}</option>)}</Select></label>
    <label><span>班级</span><Select value={selectedClassId} disabled={!value.semesterId} onChange={(event) => { const klass = classes.find((item) => item.id === event.target.value); onChange({ ...value, classId: klass?.id ?? "", className: klass?.name ?? klass?.code ?? "", sessionCode: "" }); }}><option value="">选择班级</option>{classes.map((klass) => <option key={klass.id} value={klass.id}>{klass.name ?? klass.code}</option>)}</Select></label>
    {!hideSession && <label><span>课次</span><Select value={value.sessionCode} disabled={!selectedClassId || sessions.length === 0} onChange={(event) => onChange({ ...value, sessionCode: event.target.value })}><option value="">选择课次</option>{sessions.map((session) => <option key={session.code} value={session.code}>{session.code} — 第{session.semesterNumber}次课</option>)}</Select></label>}
  </div>;
}
