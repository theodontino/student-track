"use client";

import { useEffect, useState } from "react";
import { requestJson } from "@/lib/api-client";
import type { SemesterSummary, SessionSummary, StudentSummary } from "./types";

export function useSemesters(refreshKey = 0) {
  const [items, setItems] = useState<SemesterSummary[]>([]);
  useEffect(() => { requestJson<SemesterSummary[]>("/api/semesters").then(setItems).catch(() => setItems([])); }, [refreshKey]);
  return items;
}
export function useClasses() {
  const [items, setItems] = useState<string[]>([]);
  useEffect(() => { requestJson<StudentSummary[]>("/api/students?summary=true").then((students) => setItems([...new Set(students.map((student) => student.class).filter(Boolean))])).catch(() => setItems([])); }, []);
  return items;
}
export function useSessions(semesterId: string, className: string, refreshKey = 0) {
  const [items, setItems] = useState<SessionSummary[]>([]);
  useEffect(() => { if (!semesterId || !className) { setItems([]); return; } const query = new URLSearchParams({ semesterId, className }); requestJson<SessionSummary[]>(`/api/sessions?${query}`).then(setItems).catch(() => setItems([])); }, [semesterId, className, refreshKey]);
  return items;
}
