"use client";

import { TeachingContextSelector } from "@/features/teaching-context";

interface Props {
  semesterId: string;
  onSemesterChange: (id: string) => void;
  className: string;
  onClassChange: (name: string) => void;
  sessionCode: string;
  onSessionChange: (code: string) => void;
  showDefaultOption?: boolean;
  hideSession?: boolean;
  refreshKey?: number;
}

export default function SemesterPicker({ semesterId, onSemesterChange, className, onClassChange, sessionCode, onSessionChange, hideSession = false, refreshKey = 0 }: Props) {
  return <TeachingContextSelector compact hideSession={hideSession} refreshKey={refreshKey} value={{ semesterId, className, sessionCode }} onChange={(next) => {
    if (next.semesterId !== semesterId) onSemesterChange(next.semesterId);
    if (next.className !== className) onClassChange(next.className);
    if (next.sessionCode !== sessionCode) onSessionChange(next.sessionCode);
  }} />;
}
