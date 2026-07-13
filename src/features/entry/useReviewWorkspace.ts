"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { requestJson } from "@/lib/api-client";
import type { DraftRecordView, DraftStructuredResult, ScoreDimension } from "@/lib/types";
import { useSessionWorkspace } from "@/lib/use-session-workspace";
import { isReviewWorkspaceState, type ReviewFilterStatus, type ReviewWorkspaceState } from "./workspace-state";

export function useReviewWorkspace() {
  const [drafts, setDrafts] = useState<DraftRecordView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionMessage, setActionMessage] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<ReviewFilterStatus>("pending");
  const [filterClass, setFilterClass] = useState("");
  const [classes, setClasses] = useState<string[]>([]);
  const [edits, setEdits] = useState<Record<string, DraftStructuredResult>>({});
  const workspaceValue = useMemo<ReviewWorkspaceState>(() => ({ edits, expandedId, filterStatus, filterClass }), [edits, expandedId, filterClass, filterStatus]);
  useSessionWorkspace({
    key: "entry-review",
    value: workspaceValue,
    validate: isReviewWorkspaceState,
    restore: (saved) => {
      if (!saved) return;
      setEdits(saved.edits);
      setExpandedId(saved.expandedId);
      setFilterStatus(saved.filterStatus);
      setFilterClass(saved.filterClass);
    },
  });

  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const params = new URLSearchParams({ status: filterStatus });
      if (filterClass) params.set("className", filterClass);
      setDrafts(await requestJson<DraftRecordView[]>(`/api/review?${params}`));
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "获取草稿列表失败");
    } finally {
      setLoading(false);
    }
  }, [filterClass, filterStatus]);

  useEffect(() => {
    requestJson<Array<{ class: string }>>("/api/students")
      .then((students) => setClasses([...new Set(students.map((student) => student.class))]))
      .catch(() => setClasses([]));
  }, []);

  useEffect(() => { void fetchDrafts(); }, [fetchDrafts]);

  function toggleDraft(draft: DraftRecordView) {
    if (expandedId === draft.id) {
      setExpandedId(null);
      return;
    }
    setEdits((current) => current[draft.id] ? current : { ...current, [draft.id]: structuredClone(draft.parsedResult) });
    setExpandedId(draft.id);
  }

  function updateStudent(draftId: string, studentIndex: number, update: (student: DraftStructuredResult["students"][number]) => DraftStructuredResult["students"][number]) {
    setEdits((current) => {
      const draft = current[draftId];
      if (!draft?.students[studentIndex]) return current;
      const students = [...draft.students];
      students[studentIndex] = update(students[studentIndex]);
      return { ...current, [draftId]: { ...draft, students } };
    });
  }

  function updateScore(draftId: string, studentIndex: number, dimension: ScoreDimension, value: number | null) {
    updateStudent(draftId, studentIndex, (student) => ({ ...student, scores: { ...student.scores, [dimension]: value } }));
  }

  function updateAttendance(draftId: string, studentIndex: number, present: boolean) {
    updateStudent(draftId, studentIndex, (student) => ({ ...student, present }));
  }

  function removeEvent(draftId: string, studentIndex: number, eventIndex: number) {
    updateStudent(draftId, studentIndex, (student) => ({ ...student, events: student.events.filter((_, index) => index !== eventIndex) }));
  }

  async function handleAction(draftId: string, action: "confirm" | "reject") {
    setProcessingId(draftId);
    setActionMessage(null);
    try {
      const data = await requestJson<{ warnings?: string[] }>("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId, action, ...(action === "confirm" && edits[draftId] ? { edits: edits[draftId] } : {}) }),
      });
      setActionMessage(data.warnings?.length
        ? { tone: "warning", text: data.warnings.join("；") }
        : { tone: "success", text: action === "confirm" ? "草案已确认写入。" : "草案已放弃。" });
      setExpandedId(null);
      setEdits((current) => { const next = { ...current }; delete next[draftId]; return next; });
      await fetchDrafts();
    } catch (reason) {
      setActionMessage({ tone: "danger", text: reason instanceof Error ? reason.message : "操作失败" });
    } finally {
      setProcessingId(null);
    }
  }

  return {
    drafts,
    loading,
    loadError,
    actionMessage,
    processingId,
    expandedId,
    filterStatus,
    setFilterStatus,
    filterClass,
    setFilterClass,
    classes,
    edits,
    fetchDrafts,
    toggleDraft,
    updateScore,
    updateAttendance,
    removeEvent,
    handleAction,
  };
}
