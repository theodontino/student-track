// v0.13.1: 学期/班级/课次三级联动 hook
import { useState, useEffect } from "react";

export function useSemesters() {
  const [semesters, setSemesters] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch("/api/semesters").then((r) => r.json()).then(setSemesters);
  }, []);
  return semesters;
}

export function useClasses() {
  const [classes, setClasses] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/students?summary=true")
      .then((r) => r.json())
      .then((ss: any[]) => setClasses([...new Set(ss.map((s: any) => s.class))] as string[]))
      .catch(() => {});
  }, []);
  return classes;
}

export function useSessions(semesterId: string, className: string) {
  const [sessions, setSessions] = useState<{ code: string; date: string; semesterNumber: number; class?: string | null; attendanceCount?: number; id?: string }[]>([]);
  useEffect(() => {
    if (!semesterId || !className) { setSessions([]); return; }
    fetch(`/api/sessions?semesterId=${semesterId}&className=${encodeURIComponent(className)}`)
      .then((r) => r.json()).then(setSessions);
  }, [semesterId, className]);
  return sessions;
}
