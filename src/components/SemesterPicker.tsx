"use client";

import { TeachingContextSelector } from "@/features/teaching-context/TeachingContextSelector";

interface Props {
  semesterId: string;
  onSemesterChange: (id: string) => void;
  classId?: string;
  className: string;
  onClassChange: (name: string, id?: string) => void;
  sessionCode: string;
  onSessionChange: (code: string) => void;
  showDefaultOption?: boolean;
  hideSession?: boolean;
  refreshKey?: number;
  disabled?: boolean;
}

export default function SemesterPicker({ semesterId, onSemesterChange, classId = "", className, onClassChange, sessionCode, onSessionChange, hideSession = false, refreshKey = 0, disabled = false }: Props) {
  return <TeachingContextSelector compact hideSession={hideSession} refreshKey={refreshKey} disabled={disabled} value={{ semesterId, classId, className, sessionCode }} onChange={(next) => {
    if (next.semesterId !== semesterId) onSemesterChange(next.semesterId);
    if (next.className !== className || (next.classId ?? "") !== classId) onClassChange(next.className, next.classId);
    if (next.sessionCode !== sessionCode) onSessionChange(next.sessionCode);
  }} />;
}
