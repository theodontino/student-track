// v0.13.1: 学期/班级/课次三级联动选择器
"use client";

import { useSemesters, useClasses, useSessions } from "@/hooks/useSemesterContext";

interface Props {
  semesterId: string;
  onSemesterChange: (id: string) => void;
  className: string;
  onClassChange: (name: string) => void;
  sessionCode: string;
  onSessionChange: (code: string) => void;
  showDefaultOption?: boolean;
  hideSession?: boolean;
}

export default function SemesterPicker({
  semesterId, onSemesterChange,
  className, onClassChange,
  sessionCode, onSessionChange,
  showDefaultOption = true, hideSession = false,
}: Props) {
  const semesters = useSemesters();
  const classes = useClasses();
  const sessions = useSessions(semesterId, className);

  function onSemChange(id: string) {
    onSemesterChange(id);
    onClassChange("");
    onSessionChange("");
  }

  function onClsChange(name: string) {
    onClassChange(name);
    onSessionChange("");
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <select value={semesterId} onChange={(e) => onSemChange(e.target.value)}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none">
        <option value="">{showDefaultOption ? "选择学期" : ""}</option>
        {semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {semesterId && (
        <select value={className} onChange={(e) => onClsChange(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none">
          <option value="">{showDefaultOption ? "选择班级" : ""}</option>
          {classes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      {!hideSession && className && sessions.length > 0 && (
        <select value={sessionCode} onChange={(e) => onSessionChange(e.target.value)}
          className="border border-blue-300 rounded-lg px-3 py-2 text-sm font-mono outline-none bg-blue-50">
          <option value="">{showDefaultOption ? "选择课次" : ""}</option>
          {sessions.map((s) => (
            <option key={s.code} value={s.code}>{s.code} — 第{s.semesterNumber}次课</option>
          ))}
        </select>
      )}
    </div>
  );
}
