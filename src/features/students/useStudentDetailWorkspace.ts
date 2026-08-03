"use client";

import { useCallback, useEffect, useState } from "react";
import { useTeachingContext } from "@/features/teaching-context/use-teaching-context";
import { requestJson } from "@/lib/api-client";
import type { StudentDetail, StudentDetailPanel } from "./types";

const PAGE_SIZE = 20;

export function useStudentDetailWorkspace(id: string) {
  const { context, hydrated, setSemesterId } = useTeachingContext();
  const selectedSemesterId = context.semesterId;
  const [student, setStudent] = useState<StudentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [recordsError, setRecordsError] = useState("");
  const [eventOffset, setEventOffset] = useState(0);
  const [commOffset, setCommOffset] = useState(0);
  const [eventHasMore, setEventHasMore] = useState(false);
  const [commHasMore, setCommHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState<"events" | "comms" | null>(null);
  const [activePanel, setActivePanel] = useState<StudentDetailPanel | null>(null);

  const detailQuery = useCallback((extra: Record<string, string>) => {
    const query = new URLSearchParams({ semesterSummary: "true", ...extra });
    if (selectedSemesterId) query.set("semesterId", selectedSemesterId);
    return query.toString();
  }, [selectedSemesterId]);

  const fetchStudent = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await requestJson<StudentDetail>(`/api/students/${id}?${detailQuery({
        eventLimit: String(PAGE_SIZE),
        eventOffset: "0",
        commLimit: String(PAGE_SIZE),
        commOffset: "0",
      })}`);
      setStudent(data);
      setEventHasMore(data._pagination?.eventHasMore ?? false);
      setCommHasMore(data._pagination?.commHasMore ?? false);
      setEventOffset(0);
      setCommOffset(0);
      setRecordsError("");
      if (!selectedSemesterId && data.semesterSummary?.semester.id) {
        setSemesterId(data.semesterSummary.semester.id);
      }
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "获取学生详情失败");
    } finally {
      setLoading(false);
    }
  }, [detailQuery, id, selectedSemesterId, setSemesterId]);

  useEffect(() => {
    if (hydrated) void fetchStudent();
  }, [fetchStudent, hydrated]);

  async function loadMoreEvents() {
    const nextOffset = eventOffset + PAGE_SIZE;
    setLoadingMore("events");
    setRecordsError("");
    try {
      const data = await requestJson<StudentDetail>(`/api/students/${id}?${detailQuery({
        eventLimit: String(PAGE_SIZE),
        eventOffset: String(nextOffset),
        commLimit: "0",
        commOffset: "0",
      })}`);
      setStudent((current) => current ? { ...current, events: [...current.events, ...data.events] } : current);
      setEventHasMore(data._pagination?.eventHasMore ?? false);
      setEventOffset(nextOffset);
    } catch (reason) {
      setRecordsError(reason instanceof Error ? reason.message : "加载事件失败");
    } finally {
      setLoadingMore(null);
    }
  }

  async function loadMoreCommunications() {
    const nextOffset = commOffset + PAGE_SIZE;
    setLoadingMore("comms");
    setRecordsError("");
    try {
      const data = await requestJson<StudentDetail>(`/api/students/${id}?${detailQuery({
        eventLimit: "0",
        eventOffset: "0",
        commLimit: String(PAGE_SIZE),
        commOffset: String(nextOffset),
      })}`);
      setStudent((current) => current ? { ...current, communications: [...current.communications, ...data.communications] } : current);
      setCommHasMore(data._pagination?.commHasMore ?? false);
      setCommOffset(nextOffset);
    } catch (reason) {
      setRecordsError(reason instanceof Error ? reason.message : "加载沟通记录失败");
    } finally {
      setLoadingMore(null);
    }
  }

  return {
    student,
    hydrated,
    loading,
    loadError,
    recordsError,
    selectedSemesterId,
    setSemesterId,
    fetchStudent,
    activePanel,
    setActivePanel,
    eventHasMore,
    commHasMore,
    loadingMore,
    loadMoreEvents,
    loadMoreCommunications,
  };
}
