"use client";

import { Select } from "@/components/ui";
import { useClasses, useSemesters, useSessions } from "./use-options";
import type { TeachingContext } from "./types";

export function TeachingContextSelector({ value, onChange, hideSession = false, refreshKey = 0, compact = false }: { value: TeachingContext; onChange: (value: TeachingContext) => void; hideSession?: boolean; refreshKey?: number; compact?: boolean }) {
  const semesters = useSemesters(refreshKey); const classes = useClasses(); const sessions = useSessions(value.semesterId, value.className, refreshKey);
  return <div className={`teaching-context-selector ${compact ? "is-compact" : ""}`}>
    <label><span>学期</span><Select value={value.semesterId} onChange={(event) => onChange({ semesterId: event.target.value, className: "", sessionCode: "" })}><option value="">选择学期</option>{semesters.map((semester) => <option key={semester.id} value={semester.id}>{semester.name}</option>)}</Select></label>
    <label><span>班级</span><Select value={value.className} disabled={!value.semesterId} onChange={(event) => onChange({ ...value, className: event.target.value, sessionCode: "" })}><option value="">选择班级</option>{classes.map((className) => <option key={className} value={className}>{className}</option>)}</Select></label>
    {!hideSession && <label><span>课次</span><Select value={value.sessionCode} disabled={!value.className || sessions.length === 0} onChange={(event) => onChange({ ...value, sessionCode: event.target.value })}><option value="">选择课次</option>{sessions.map((session) => <option key={session.code} value={session.code}>{session.code} — 第{session.semesterNumber}次课</option>)}</Select></label>}
  </div>;
}
