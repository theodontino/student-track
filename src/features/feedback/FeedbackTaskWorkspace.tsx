"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import packageMetadata from "../../../package.json";
import SemesterPicker from "@/components/SemesterPicker";
import { Badge, Button, PageHeader, StatusBanner } from "@/components/ui";
import { SessionDialog } from "@/features/courses";
import { requestJson } from "@/lib/api-client";
import { lessonMaterialHasContent } from "@/lib/feedback-materials";
import type { FeedbackScriptLibraryResponse } from "@/lib/feedback-script-library";
import type { FeedbackIntakeDecision } from "@/services/feedback-intake-service";
import { isBlockingFeedbackIntakeIssue, isSourceScopedBoundaryIssue } from "@/lib/feedback-intake-rules";
import FeedbackPlanManager from "./FeedbackPlanManager";
import { TaskPreparationStage, type GroupMaterialSummary } from "./TaskPreparationStage";
import { TaskConfirmationStage } from "./TaskConfirmationStage";
import { FeedbackTaskStudioStage } from "./FeedbackTaskStudioStage";
import type { FeedbackContextStudent } from "./context-types";
import type {
  FeedbackGroupIntakeSourceSummary,
  FeedbackGroupIntakeUnassigned,
  FeedbackGroupIntakeUploadResponse,
  FeedbackIntakeRunClient,
  FeedbackStudioPlanTarget,
} from "./feedback-task-types";
import {
  activeTaskEntry,
  createFeedbackTaskDraft,
  feedbackTaskReducer,
  resolveFeedbackTaskMaterialChoice,
  type FeedbackTaskClassDraft,
  type FeedbackTaskGroupSnapshot,
  type FeedbackTaskState,
} from "./feedback-task-state";
import {
  clearFeedbackTaskDraft,
  feedbackTaskDraftScopeKey,
  readFeedbackTaskDraft,
  useFeedbackTaskDraftPersistence,
  type FeedbackTaskDraftScope,
} from "./useFeedbackTaskDraft";
import { isFeedbackTaskContextCurrent, useFeedbackTaskContext } from "./useFeedbackTaskContext";
import styles from "./unified-feedback-workspace.module.css";

function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : "操作失败"; }

function selectedFeedbackIntakeDecision(issue: FeedbackIntakeRunClient["issues"][number], decisions: FeedbackIntakeDecision[]) {
  return decisions.find((decision) => decision.issueId === issue.id)
    ?? decisions.find((decision) => issue.sourceName && decision.sourceName === issue.sourceName && (
      decision.action === "ignore_source" || (decision.action === "accept_source" && isSourceScopedBoundaryIssue(issue))
    ));
}

type ActiveRosterStudent = { id: string; classId: string };

export function activeFeedbackStudentsForClass<T extends { id: string }>(students: T[], activeRoster: ActiveRosterStudent[], classId: string) {
  const activeIds = new Set(activeRoster.filter((student) => student.classId === classId).map((student) => student.id));
  return students.filter((student) => activeIds.has(student.id));
}

export function recommendedFeedbackStudentIds(
  students: Array<Pick<FeedbackContextStudent, "id" | "feedbackRecommendationReasons">>,
  assessmentEvidence: Record<string, unknown> = {},
) {
  const availableIds = new Set(students.map((student) => student.id));
  return [...new Set([
    ...students.filter((student) => (student.feedbackRecommendationReasons?.length ?? 0) > 0).map((student) => student.id),
    ...Object.keys(assessmentEvidence).filter((studentId) => availableIds.has(studentId)),
  ])];
}

function isActionableUnassignedSource(source: FeedbackGroupIntakeUnassigned) {
  return source.kind !== "ignored" && source.blocking !== false;
}

export function mergeGroupUnassignedSources(
  current: FeedbackGroupIntakeUnassigned[],
  incoming: FeedbackGroupIntakeUnassigned[],
  routedFileNames: Set<string>,
) {
  const merged = new Map<string, FeedbackGroupIntakeUnassigned>();
  for (const source of current) {
    if (isActionableUnassignedSource(source) && !routedFileNames.has(source.fileName)) {
      merged.set(`${source.kind}\u0000${source.fileName}`, source);
    }
  }
  for (const source of incoming) merged.set(`${source.kind}\u0000${source.fileName}`, source);
  return [...merged.values()];
}

export function mergeLoadedGroupRosterEntries(
  entries: FeedbackTaskClassDraft[],
  studentIdsBySession: Map<string, string[]>,
) {
  return entries.map((item) => {
    if (!studentIdsBySession.has(item.sessionCode)) return item;
    const validIds = new Set(studentIdsBySession.get(item.sessionCode));
    const selectedIds = item.studentIds.length ? item.studentIds.filter((id) => validIds.has(id)) : [...validIds];
    return selectedIds.length === item.studentIds.length && selectedIds.every((id, index) => id === item.studentIds[index]) && item.studentSelectionInitialized
      ? item
      : { ...item, studentIds: selectedIds, studentSelectionInitialized: true };
  });
}

type FeedbackGroupModeSnapshot = FeedbackTaskGroupSnapshot & {
  sourceSummaries: FeedbackGroupIntakeSourceSummary[];
  unassignedSources: FeedbackGroupIntakeUnassigned[];
};

type FeedbackGroupSessionMember = {
  classId: string;
  classCode: string;
  className?: string | null;
  session?: { code: string } | null;
};

export function restoreFeedbackGroupMode(input: {
  groupLessonId: string;
  members: FeedbackGroupSessionMember[];
  currentEntries: FeedbackTaskClassDraft[];
  studentsBySession: Record<string, Array<{ id: string }>>;
  snapshot: FeedbackGroupModeSnapshot | null;
}) {
  const saved = input.snapshot?.groupLessonId === input.groupLessonId ? input.snapshot : null;
  const previous = new Map((saved?.entries ?? input.currentEntries).map((item) => [item.sessionCode, item]));
  const entries = input.members.flatMap((member) => member.session ? [{
    classId: member.classId,
    classCode: member.classCode,
    className: member.className ?? member.classCode,
    sessionCode: member.session.code,
    runId: previous.get(member.session.code)?.runId ?? "",
    studentIds: previous.get(member.session.code)?.studentIds
      ?? input.studentsBySession[member.session.code]?.map((student) => student.id)
      ?? [],
    studentSelectionInitialized: true,
    selected: true,
  } satisfies FeedbackTaskClassDraft] : []);
  return {
    entries,
    activeSessionCode: saved?.activeSessionCode ?? "",
    sourceSummaries: saved?.sourceSummaries ?? [],
    unassignedSources: saved?.unassignedSources ?? [],
    unassignedSourceCount: saved?.unassignedSourceCount ?? 0,
  };
}

function restoredSourceStatus(input: { fileCount: number; matched: number; total: number; issueCount: number }): FeedbackGroupIntakeSourceSummary["status"] {
  if (input.fileCount === 0) return "empty";
  if (input.issueCount > 0) return "needs_review";
  if (input.matched === 0) return "unassigned";
  if (input.matched < input.total) return "partial";
  return "complete";
}

export function rebuildGroupSourceSummaries(
  entries: FeedbackTaskClassDraft[],
  runs: Record<string, FeedbackIntakeRunClient>,
): FeedbackGroupIntakeSourceSummary[] {
  const sourceNames = {
    assistant_roster: new Set<string>(),
    step_classroom: new Set<string>(),
    assessment_pdf: new Set<string>(),
  };
  const matchedClasses = {
    assistant_roster: new Set<string>(),
    step_classroom: new Set<string>(),
  };
  const matchedStudents = new Set<string>();
  const issueCounts = { assistant_roster: 0, step_classroom: 0, assessment_pdf: 0 };

  for (const entry of entries) {
    const run = entry.runId ? runs[entry.runId] : undefined;
    if (!run) continue;
    const kindBySourceName = new Map<string, keyof typeof sourceNames>();
    run.sourceManifest.forEach((source, index) => {
      if (source.kind !== "assistant_roster" && source.kind !== "step_classroom" && source.kind !== "assessment_pdf") return;
      const sourceName = typeof source.name === "string" && source.name ? source.name : `${run.id}:${index}`;
      sourceNames[source.kind].add(sourceName);
      if (typeof source.name === "string" && source.name) kindBySourceName.set(source.name, source.kind);
      if (source.kind === "assistant_roster" || source.kind === "step_classroom") matchedClasses[source.kind].add(entry.classId);
    });
    for (const studentId of Object.keys(run.appliedSummary.assessmentEvidence ?? {})) matchedStudents.add(studentId);
    if (run.status !== "applied") {
      for (const issue of run.issues) {
        const kind = issue.sourceName ? kindBySourceName.get(issue.sourceName) : undefined;
        if (kind) issueCounts[kind] += 1;
      }
    }
  }

  const totalClasses = entries.length;
  const totalStudents = new Set(entries.flatMap((item) => item.studentIds)).size;
  const assistantFileCount = sourceNames.assistant_roster.size;
  const assistantMatchedClasses = matchedClasses.assistant_roster.size;
  const stepFileCount = sourceNames.step_classroom.size;
  const stepMatchedClasses = matchedClasses.step_classroom.size;
  const assessmentFileCount = sourceNames.assessment_pdf.size;
  const assessmentMatchedStudents = matchedStudents.size;
  return [
    {
      kind: "assistant_roster",
      fileCount: assistantFileCount,
      matchedClasses: assistantMatchedClasses,
      totalClasses,
      issueCount: issueCounts.assistant_roster,
      status: restoredSourceStatus({ fileCount: assistantFileCount, matched: assistantMatchedClasses, total: totalClasses, issueCount: issueCounts.assistant_roster }),
    },
    {
      kind: "step_classroom",
      fileCount: stepFileCount,
      matchedClasses: stepMatchedClasses,
      totalClasses,
      issueCount: issueCounts.step_classroom,
      status: restoredSourceStatus({ fileCount: stepFileCount, matched: stepMatchedClasses, total: totalClasses, issueCount: issueCounts.step_classroom }),
    },
    {
      kind: "assessment_pdf",
      fileCount: assessmentFileCount,
      matchedStudents: assessmentMatchedStudents,
      totalStudents,
      issueCount: issueCounts.assessment_pdf,
      status: restoredSourceStatus({ fileCount: assessmentFileCount, matched: assessmentMatchedStudents, total: totalStudents, issueCount: issueCounts.assessment_pdf }),
    },
  ];
}

function initialState({ planId, batchId }: { planId: string; batchId: string }): FeedbackTaskState {
  return { stage: planId || batchId ? "studio" : "prepare", draft: createFeedbackTaskDraft(), planId, batchId };
}

function taskUrl(patch: { planId?: string; batchId?: string; intakeRunId?: string }) {
  const url = new URL(window.location.href);
  for (const key of ["step", "advanced", "groupMode"]) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(patch)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function scopeMatchesEntry(entry: FeedbackTaskClassDraft, run: FeedbackIntakeRunClient | undefined) {
  const scope = run?.appliedSummary.scopeConfirmation;
  return Boolean(
    scope
    && scope.classId === entry.classId
    && scope.sessionCode === entry.sessionCode
    && scope.studentIds.length === entry.studentIds.length
    && entry.studentIds.every((id) => scope.studentIds.includes(id)),
  );
}

export default function FeedbackTaskWorkspace({ initialPlanId = "", initialBatchId = "" }: { initialPlanId?: string; initialBatchId?: string }) {
  const context = useFeedbackTaskContext();
  const [state, dispatch] = useReducer(feedbackTaskReducer, { planId: initialPlanId, batchId: initialBatchId }, initialState);
  const [runs, setRuns] = useState<Record<string, FeedbackIntakeRunClient>>({});
  const [decisions, setDecisions] = useState<Record<string, FeedbackIntakeDecision[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [scriptLibrary, setScriptLibrary] = useState<FeedbackScriptLibraryResponse>({ library: null, recommendedLessonNumber: null });
  const [studentsBySession, setStudentsBySession] = useState<Record<string, FeedbackContextStudent[]>>({});
  const [sourceSummaries, setSourceSummaries] = useState<FeedbackGroupIntakeSourceSummary[]>([]);
  const [unassignedSources, setUnassignedSources] = useState<FeedbackGroupIntakeUnassigned[]>([]);
  const [loadingGroupRosters, setLoadingGroupRosters] = useState(false);
  const [loadingSingleRoster, setLoadingSingleRoster] = useState(false);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const restoredScopeKey = useRef("");
  const restoredFromStorage = useRef(false);
  const groupEntriesRef = useRef(state.draft.entries);
  const groupDraftModeRef = useRef(state.draft.mode);
  const groupModeSnapshotRef = useRef<FeedbackGroupModeSnapshot | null>(null);
  const rebuildingRestoredSourceSummaries = useRef(false);
  const loadedGroupRosterKey = useRef("");
  const loadedSingleRosterKey = useRef("");
  const materialContextKey = useRef("");
  const entry = activeTaskEntry(state);
  const groupLesson = context.data?.groupProgress?.lesson;
  const group = context.data?.groupProgress?.group;
  const realGroupMembers = (group?.members ?? []).filter((member) => Boolean(member.session));
  const groupAvailable = Boolean(groupLesson && realGroupMembers.length >= 2);
  const contextCurrent = isFeedbackTaskContextCurrent(context.data, context.context);
  const taskScopeCurrent = contextCurrent && (state.draft.mode === "group"
    ? Boolean(groupLesson && state.draft.groupLessonId === groupLesson.id)
    : Boolean(
        entry
        && entry.classId === context.data?.session?.classId
        && entry.sessionCode === context.data?.session?.code,
      ));
  const contextActionBlocked = context.loading || !taskScopeCurrent;
  const groupSessionKey = state.draft.mode === "group" ? state.draft.entries.map((item) => item.sessionCode).sort().join("|") : "";
  const confirmedGroupRevisionId = context.data?.groupProgress?.lesson?.revisions?.[0]?.id ?? "";
  const confirmedSessionMaterialAt = context.data?.sessionCommonMaterial?.confirmedAt ?? "";
  const draftScriptLessonNumber = context.data?.groupProgress?.lesson?.draftMaterial.semesterScriptSource?.lessonNumber ?? null;
  const draftScope: FeedbackTaskDraftScope = {
    semesterId: context.context.semesterId,
    classId: state.draft.mode === "single" ? entry?.classId ?? context.context.classId ?? "" : context.context.classId ?? "",
    sessionCode: state.draft.mode === "single" ? entry?.sessionCode ?? context.context.sessionCode : context.context.sessionCode,
    ...(state.draft.mode === "group" && state.draft.groupLessonId ? { groupLessonId: state.draft.groupLessonId } : {}),
  };
  const currentDraftScopeKey = draftScope.semesterId && (draftScope.groupLessonId || (draftScope.classId && draftScope.sessionCode))
    ? feedbackTaskDraftScopeKey(draftScope)
    : "";

  useFeedbackTaskDraftPersistence(state.draft, context.hydrated && state.stage !== "studio", draftScope);

  useEffect(() => {
    groupEntriesRef.current = state.draft.entries;
    groupDraftModeRef.current = state.draft.mode;
  }, [state.draft.entries, state.draft.mode]);

  useEffect(() => {
    if (state.draft.mode !== "group" || !state.draft.groupLessonId) return;
    groupModeSnapshotRef.current = {
      groupLessonId: state.draft.groupLessonId,
      activeSessionCode: state.draft.activeSessionCode,
      entries: state.draft.entries,
      sourceSummaries,
      unassignedSources,
      unassignedSourceCount: state.draft.unassignedSourceCount,
    };
  }, [sourceSummaries, state.draft.activeSessionCode, state.draft.entries, state.draft.groupLessonId, state.draft.mode, state.draft.unassignedSourceCount, unassignedSources]);

  useEffect(() => {
    if (!context.hydrated) return;
    const params = new URLSearchParams(window.location.search);
    const planId = params.get("planId") ?? "";
    const batchId = params.get("batchId") ?? "";
    if ((planId || batchId) && (state.stage !== "studio" || state.planId !== planId || state.batchId !== batchId)) {
      dispatch({ type: "task", planId, batchId });
    }
  }, [context.hydrated, state.batchId, state.planId, state.stage]);

  useEffect(() => {
    if (!context.hydrated || !currentDraftScopeKey || restoredScopeKey.current === currentDraftScopeKey || state.planId || state.batchId) return;
    restoredScopeKey.current = currentDraftScopeKey;
    const saved = readFeedbackTaskDraft(draftScope);
    restoredFromStorage.current = Boolean(saved);
    if (saved) dispatch({ type: "restore", draft: saved });
  }, [context.hydrated, currentDraftScopeKey, draftScope, state.batchId, state.planId]);

  useEffect(() => {
    const session = context.data?.session;
    if (!session || state.stage !== "prepare") return;
    const nextKey = `${context.context.semesterId}:${session.code}`;
    if (!materialContextKey.current) {
      materialContextKey.current = nextKey;
      return;
    }
    if (materialContextKey.current === nextKey) return;
    materialContextKey.current = nextKey;
    restoredFromStorage.current = false;
    dispatch({ type: "draft", patch: { materialSelection: { mode: "none" }, materialSelectionInitialized: false, pendingMaterialLessonNumber: null } });
  }, [context.context.semesterId, context.data?.session, state.stage]);

  const loadRun = useCallback(async (runId: string) => {
    const result = await requestJson<{ run: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(runId)}`);
    if (groupDraftModeRef.current === "group") rebuildingRestoredSourceSummaries.current = true;
    setRuns((current) => ({ ...current, [runId]: result.run }));
    const stored = Array.isArray(result.run.appliedSummary.decisions) ? result.run.appliedSummary.decisions : [];
    setDecisions((current) => ({ ...current, [runId]: stored }));
    return result.run;
  }, []);

  useEffect(() => {
    for (const item of state.draft.entries) if (item.runId && !runs[item.runId]) void loadRun(item.runId).catch(() => undefined);
  }, [loadRun, runs, state.draft.entries]);

  useEffect(() => {
    if (state.draft.mode !== "group" || !rebuildingRestoredSourceSummaries.current) return;
    setSourceSummaries(rebuildGroupSourceSummaries(state.draft.entries, runs));
    if (state.draft.entries.every((item) => !item.runId || Boolean(runs[item.runId]))) {
      rebuildingRestoredSourceSummaries.current = false;
    }
  }, [runs, state.draft.entries, state.draft.mode]);

  useEffect(() => {
    if (!context.data?.session || state.stage === "studio") return;
    const session = context.data.session;
    const lesson = context.data.groupProgress?.lesson;
    const members = (context.data.groupProgress?.group.members ?? []).filter((member) => Boolean(member.session));
    const groupStillApplies = state.draft.mode === "group"
      && Boolean(lesson)
      && state.draft.groupLessonId === lesson?.id
      && members.length >= 2
      && members.some((member) => member.session?.code === session.code);
    if (groupStillApplies) {
      const previous = new Map(state.draft.entries.map((item) => [item.sessionCode, item]));
      const nextEntries = members.flatMap((member) => member.session ? [{
        classId: member.classId,
        classCode: member.classCode,
        className: member.className ?? member.classCode,
        sessionCode: member.session.code,
        runId: previous.get(member.session.code)?.runId ?? "",
        studentIds: previous.get(member.session.code)?.studentIds
          ?? (member.session.code === session.code ? context.data!.students.map((student) => student.id) : []),
        studentSelectionInitialized: true,
        selected: true,
      }] : []);
      const unchanged = nextEntries.length === state.draft.entries.length && nextEntries.every((next, index) => {
        const current = state.draft.entries[index];
        return current?.classId === next.classId
          && current.classCode === next.classCode
          && current.className === next.className
          && current.sessionCode === next.sessionCode
          && current.runId === next.runId
          && current.selected === next.selected
          && current.studentIds.length === next.studentIds.length
          && current.studentIds.every((id, studentIndex) => id === next.studentIds[studentIndex]);
      });
      if (!unchanged || !nextEntries.some((item) => item.sessionCode === state.draft.activeSessionCode)) {
        dispatch({ type: "draft", patch: { entries: nextEntries, activeSessionCode: nextEntries.some((item) => item.sessionCode === state.draft.activeSessionCode) ? state.draft.activeSessionCode : session.code } });
      }
      return;
    }
    const existing = state.draft.entries.find((item) => item.sessionCode === session.code);
    if (existing) {
      if (state.draft.mode !== "single" || state.draft.entries.length !== 1 || state.draft.activeSessionCode !== session.code) {
        dispatch({ type: "draft", patch: { mode: "single", groupLessonId: "", entries: [{ ...existing, selected: true }], activeSessionCode: session.code } });
      }
      return;
    }
    const current: FeedbackTaskClassDraft = {
      classId: session.classId,
      classCode: context.context.className,
      className: context.context.className || context.data.className,
      sessionCode: session.code,
      runId: "",
      studentIds: [],
      studentSelectionInitialized: false,
      selected: true,
    };
    dispatch({ type: "entries", entries: [current] });
    dispatch({ type: "draft", patch: { activeSessionCode: session.code } });
  }, [context.context.className, context.data, state.draft.activeSessionCode, state.draft.entries, state.draft.groupLessonId, state.draft.mode, state.stage, studentsBySession]);

  useEffect(() => {
    const session = context.data?.session;
    if (state.draft.mode !== "single" || !session || !context.context.semesterId || state.stage === "studio") {
      setLoadingSingleRoster(false);
      return;
    }
    if (!state.draft.entries.some((item) => item.sessionCode === session.code)) return;
    const rosterKey = `${context.context.semesterId}:${session.classId}:${session.code}`;
    if (loadedSingleRosterKey.current === rosterKey) return;
    let cancelled = false;
    setLoadingSingleRoster(true);
    void requestJson<ActiveRosterStudent[]>(`/api/students?${new URLSearchParams({ semesterId: context.context.semesterId, scope: "active" })}`)
      .then((activeRoster) => {
        if (cancelled) return;
        const students = activeFeedbackStudentsForClass(context.data!.students, activeRoster, session.classId);
        const activeIds = new Set(students.map((student) => student.id));
        setStudentsBySession((current) => ({ ...current, [session.code]: students }));
        const currentEntry = groupEntriesRef.current.find((item) => item.sessionCode === session.code);
        const selectedIds = currentEntry?.studentSelectionInitialized
          ? currentEntry.studentIds.filter((studentId) => activeIds.has(studentId))
          : recommendedFeedbackStudentIds(students, currentEntry?.runId ? runs[currentEntry.runId]?.appliedSummary.assessmentEvidence : {});
        dispatch({ type: "entry", sessionCode: session.code, patch: { studentIds: selectedIds, studentSelectionInitialized: true } });
        loadedSingleRosterKey.current = rosterKey;
      })
      .catch((reason) => {
        if (!cancelled) setError(`ACTIVE 花名册读取失败：${errorMessage(reason)}。请切换课次后重试。`);
      })
      .finally(() => { if (!cancelled) setLoadingSingleRoster(false); });
    return () => { cancelled = true; };
  }, [context.context.semesterId, context.data, runs, state.draft.entries, state.draft.mode, state.stage]);

  useEffect(() => {
    if (state.draft.mode !== "group" || !context.context.semesterId || !groupSessionKey || state.stage === "studio") {
      setLoadingGroupRosters(false);
      return;
    }
    const rosterKey = `${context.context.semesterId}:${state.draft.groupLessonId}:${groupSessionKey}`;
    if (loadedGroupRosterKey.current === rosterKey) return;
    let cancelled = false;
    setLoadingGroupRosters(true);
    const entries = groupEntriesRef.current;
    void Promise.all([
      requestJson<ActiveRosterStudent[]>(`/api/students?${new URLSearchParams({ semesterId: context.context.semesterId, scope: "active" })}`),
      Promise.allSettled(entries.map(async (item) => {
        const query = new URLSearchParams({ semesterId: context.context.semesterId, sessionCode: item.sessionCode });
        const result = await requestJson<import("./types").FeedbackContextResponse>(`/api/report/feedback-context?${query}`);
        return { sessionCode: item.sessionCode, students: result.students };
      })),
    ]).then(([activeRoster, results]) => {
      if (cancelled) return;
      const activeIdsByClass = new Map<string, Set<string>>();
      for (const student of activeRoster) {
        const ids = activeIdsByClass.get(student.classId) ?? new Set<string>();
        ids.add(student.id);
        activeIdsByClass.set(student.classId, ids);
      }
      const entryBySession = new Map(entries.map((item) => [item.sessionCode, item]));
      const loaded = results.flatMap((result) => {
        if (result.status !== "fulfilled") return [];
        const target = entryBySession.get(result.value.sessionCode);
        const activeIds = target ? activeIdsByClass.get(target.classId) ?? new Set<string>() : new Set<string>();
        return [{ ...result.value, students: result.value.students.filter((student) => activeIds.has(student.id)) }];
      });
      setStudentsBySession((current) => Object.assign({}, current, ...loaded.map((item) => ({ [item.sessionCode]: item.students }))));
      const studentIds = new Map(loaded.map((item) => [item.sessionCode, item.students.map((student) => student.id)]));
      const nextEntries = mergeLoadedGroupRosterEntries(entries, studentIds);
      if (nextEntries.some((item, index) => item !== entries[index])) dispatch({ type: "entries", entries: nextEntries });
      const failed = results.length - loaded.length;
      if (failed) {
        setError(`有 ${failed} 个班的花名册读取失败，请重试共同课选择。`);
      } else {
        loadedGroupRosterKey.current = rosterKey;
      }
    }).catch((reason) => {
      if (!cancelled) setError(`ACTIVE 花名册读取失败：${errorMessage(reason)}。请重新选择共同课后重试。`);
    }).finally(() => { if (!cancelled) setLoadingGroupRosters(false); });
    return () => { cancelled = true; };
  }, [context.context.semesterId, groupSessionKey, state.draft.groupLessonId, state.draft.mode, state.stage]);

  useEffect(() => {
    if (!restoredScopeKey.current || restoredFromStorage.current || !context.data || state.stage === "studio" || state.draft.materialSelectionInitialized) return;
    const revision = context.data.groupProgress?.status === "linked" ? context.data.groupProgress.lesson?.revisions?.[0] : null;
    if (revision) {
      dispatch({ type: "draft", patch: { materialSelection: { mode: "linked_revision", revisionId: revision.id }, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
    } else if (context.data.sessionCommonMaterial?.confirmedAt) {
      dispatch({ type: "draft", patch: { materialSelection: { mode: "session_snapshot" }, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
    }
  }, [context.data, state.draft.materialSelectionInitialized, state.stage]);

  useEffect(() => {
    if (!context.context.semesterId || !context.context.sessionCode || state.stage === "studio") {
      setScriptLibrary({ library: null, recommendedLessonNumber: null });
      return;
    }
    let cancelled = false;
    const query = new URLSearchParams({ semesterId: context.context.semesterId, sessionCode: context.context.sessionCode });
    requestJson<FeedbackScriptLibraryResponse>(`/api/feedback/script-library?${query}`)
      .then((result) => {
        if (cancelled) return;
        setScriptLibrary(result);
        if (!restoredFromStorage.current && !state.draft.materialSelectionInitialized && context.data?.session?.id) {
          const revisionId = context.data?.groupProgress?.status === "linked" ? confirmedGroupRevisionId : "";
          const sourceLesson = draftScriptLessonNumber ?? result.recommendedLessonNumber;
          dispatch({
            type: "draft",
            patch: revisionId
              ? { materialSelection: { mode: "linked_revision", revisionId }, materialSelectionInitialized: true, pendingMaterialLessonNumber: null }
              : confirmedSessionMaterialAt
                ? { materialSelection: { mode: "session_snapshot" }, materialSelectionInitialized: true, pendingMaterialLessonNumber: null }
                : { materialSelection: { mode: "none" }, materialSelectionInitialized: true, pendingMaterialLessonNumber: sourceLesson ?? null },
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScriptLibrary({ library: null, recommendedLessonNumber: null });
          if (!restoredFromStorage.current && !state.draft.materialSelectionInitialized && context.data?.session?.id) {
            dispatch({ type: "draft", patch: { materialSelection: { mode: "none" }, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
          }
        }
      });
    return () => { cancelled = true; };
  }, [confirmedGroupRevisionId, confirmedSessionMaterialAt, context.context.semesterId, context.context.sessionCode, context.data?.groupProgress?.lesson?.id, context.data?.groupProgress?.status, context.data?.session?.id, draftScriptLessonNumber, state.draft.materialSelectionInitialized, state.stage]);

  function setTaskMode(mode: "single" | "group") {
    if (mode === "group") {
      if (!groupAvailable || !groupLesson) return;
      loadedGroupRosterKey.current = "";
      setLoadingGroupRosters(true);
      setStudentsBySession((current) => {
        const next = { ...current };
        for (const member of realGroupMembers) if (member.session) delete next[member.session.code];
        return next;
      });
      const persistedSnapshot = state.draft.groupSnapshot?.groupLessonId === groupLesson.id
        ? {
            ...state.draft.groupSnapshot,
            sourceSummaries: [],
            unassignedSources: [],
          }
        : null;
      const restoredGroup = restoreFeedbackGroupMode({
        groupLessonId: groupLesson.id,
        members: realGroupMembers,
        currentEntries: state.draft.entries,
        studentsBySession,
        snapshot: groupModeSnapshotRef.current?.groupLessonId === groupLesson.id
          ? groupModeSnapshotRef.current
          : persistedSnapshot,
      });
      const entries = restoredGroup.entries;
      const revision = context.data?.groupProgress?.lesson?.revisions?.[0];
      const materialPatch = !state.draft.materialSelectionInitialized && revision
        ? { materialSelection: { mode: "linked_revision" as const, revisionId: revision.id }, materialSelectionInitialized: true, pendingMaterialLessonNumber: null }
        : state.draft.materialSelection.mode === "session_snapshot" && revision
          ? { materialSelection: { mode: "linked_revision" as const, revisionId: revision.id }, pendingMaterialLessonNumber: null }
          : {};
      dispatch({
        type: "draft",
        patch: {
          mode: "group",
          groupLessonId: groupLesson.id,
          entries,
          activeSessionCode: entries.some((item) => item.sessionCode === restoredGroup.activeSessionCode)
            ? restoredGroup.activeSessionCode
            : entries.some((item) => item.sessionCode === context.context.sessionCode)
              ? context.context.sessionCode
              : entries[0]?.sessionCode ?? "",
          unassignedSourceCount: restoredGroup.unassignedSourceCount,
          groupSnapshot: null,
          ...materialPatch,
        },
      });
      setSourceSummaries(restoredGroup.sourceSummaries);
      setUnassignedSources(restoredGroup.unassignedSources);
      setError("");
      return;
    }
    const session = context.data?.session;
    if (!session) return;
    let groupSnapshot: FeedbackTaskGroupSnapshot | null = state.draft.groupSnapshot;
    if (state.draft.mode === "group" && state.draft.groupLessonId) {
      const snapshot: FeedbackGroupModeSnapshot = {
        groupLessonId: state.draft.groupLessonId,
        activeSessionCode: state.draft.activeSessionCode,
        entries: state.draft.entries,
        sourceSummaries,
        unassignedSources,
        unassignedSourceCount: state.draft.unassignedSourceCount,
      };
      groupModeSnapshotRef.current = snapshot;
      groupSnapshot = {
        groupLessonId: snapshot.groupLessonId,
        activeSessionCode: snapshot.activeSessionCode,
        entries: snapshot.entries,
        unassignedSourceCount: snapshot.unassignedSourceCount,
      };
    }
    const previous = state.draft.entries.find((item) => item.sessionCode === session.code);
    const current: FeedbackTaskClassDraft = previous ?? {
      classId: session.classId,
      classCode: context.context.className,
      className: context.context.className || context.data?.className || context.context.className,
      sessionCode: session.code,
      runId: "",
      studentIds: [],
      studentSelectionInitialized: false,
      selected: true,
    };
    dispatch({ type: "draft", patch: { mode: "single", groupLessonId: "", entries: [{ ...current, selected: true }], activeSessionCode: current.sessionCode, unassignedSourceCount: 0, groupSnapshot } });
    setSourceSummaries([]);
    setUnassignedSources([]);
  }

  function activeGroupRunIds() {
    return Object.fromEntries(state.draft.entries.flatMap((item) => item.runId && !runs[item.runId]?.planId ? [[item.sessionCode, item.runId]] : []));
  }

  function acceptRun(result: { run: FeedbackIntakeRunClient }) {
    setRuns((current) => ({ ...current, [result.run.id]: result.run }));
    setDecisions((current) => ({ ...current, [result.run.id]: Array.isArray(result.run.appliedSummary.decisions) ? result.run.appliedSummary.decisions : [] }));
    dispatch({ type: "entry", sessionCode: result.run.sessionCode, patch: { runId: result.run.id } });
    dispatch({ type: "draft", patch: { unassignedSourceCount: 0 } });
    setSourceSummaries([]);
    setUnassignedSources([]);
    taskUrl({ intakeRunId: result.run.id });
    setNotice(result.run.issues.some(isBlockingFeedbackIntakeIssue) ? "材料已整理；进入下一阶段只处理真正阻断归属的问题。" : "材料已整理，等待教师确认。 ");
  }

  function acceptGroupIntake(result: FeedbackGroupIntakeUploadResponse) {
    rebuildingRestoredSourceSummaries.current = false;
    const nextRuns = Object.fromEntries(result.runs.map((run) => [run.id, run]));
    setRuns((current) => ({ ...current, ...nextRuns }));
    setDecisions((current) => Object.assign({}, current, ...result.runs.map((run) => ({
      [run.id]: Array.isArray(run.appliedSummary.decisions) ? run.appliedSummary.decisions : [],
    }))));
    const latestEntries = groupEntriesRef.current;
    const previous = new Map(latestEntries.map((item) => [item.sessionCode, item]));
    setStudentsBySession((current) => Object.assign({}, current, ...result.classes.map((item) => {
      const validStudentIds = new Set(item.studentIds);
      return { [item.sessionCode]: (current[item.sessionCode] ?? []).filter((student) => validStudentIds.has(student.id)) };
    })));
    const entries = result.classes.map((item) => {
      const old = previous.get(item.sessionCode);
      const rosterWasLoaded = Boolean(studentsBySession[item.sessionCode]);
      const validStudentIds = new Set(item.studentIds);
      return {
        classId: item.classId,
        classCode: item.classCode,
        className: item.className || item.classCode,
        sessionCode: item.sessionCode,
        runId: item.runId,
        studentIds: rosterWasLoaded && old ? old.studentIds.filter((id) => validStudentIds.has(id)) : item.studentIds,
        studentSelectionInitialized: true,
        selected: true,
      } satisfies FeedbackTaskClassDraft;
    });
    const routedFileNames = new Set<string>();
    for (const run of result.runs) {
      for (const source of run.sourceManifest) {
        if (typeof source.name === "string" && source.name) routedFileNames.add(source.name);
      }
    }
    const mergedUnassigned = mergeGroupUnassignedSources(unassignedSources, result.unassigned, routedFileNames);
    const previouslyKnownActionable = unassignedSources.filter(isActionableUnassignedSource).length;
    const restoredUnknownActionable = Math.max(0, state.draft.unassignedSourceCount - previouslyKnownActionable);
    const nextActionableCount = restoredUnknownActionable + mergedUnassigned.filter(isActionableUnassignedSource).length;
    dispatch({
      type: "draft",
      patch: {
        entries,
        activeSessionCode: entries.some((item) => item.sessionCode === state.draft.activeSessionCode) ? state.draft.activeSessionCode : entries[0]?.sessionCode ?? "",
        unassignedSourceCount: nextActionableCount,
      },
    });
    setSourceSummaries(result.sourceSummaries);
    setUnassignedSources(mergedUnassigned);
    taskUrl({ intakeRunId: "" });
    const actionableUnassigned = result.unassigned.filter(isActionableUnassignedSource).length;
    const skippedSourceCount = result.unassigned.length - actionableUnassigned;
    const needsReview = nextActionableCount > 0 || result.runs.some((run) => run.issues.some(isBlockingFeedbackIntakeIssue));
    const skipped = skippedSourceCount ? `另有 ${skippedSourceCount} 个不属于当前共同课或无需处理的文件已跳过。` : "";
    setNotice(`${needsReview ? "共同课材料已按各班花名册拆分；进入下一阶段处理阻断异常。" : `共同课材料已一次拆分到 ${entries.length} 个班，等待教师确认。`}${skipped}`);
  }

  function ignoreUnassignedSources() {
    setUnassignedSources([]);
    dispatch({ type: "draft", patch: { unassignedSourceCount: 0 } });
    setNotice("已明确不采用这些未归属材料；如果它们仍在收件箱，下次扫描时还会再次提示。 ");
  }

  async function uploadFiles(files: File[]) {
    if (!entry || !files.length) return;
    if (contextActionBlocked) {
      setError("课次上下文正在切换，请等当前班级和课次加载完成后再投料。");
      return;
    }
    setBusy(true); setError(""); setNotice("正在整理材料…");
    try {
      const form = new FormData();
      form.set("displayNames", JSON.stringify(files.map((file) => file.webkitRelativePath || file.name)));
      for (const file of files) form.append("files", file);
      if (state.draft.mode === "group") {
        form.set("groupLessonId", state.draft.groupLessonId);
        const runIds = activeGroupRunIds();
        if (Object.keys(runIds).length) form.set("runIds", JSON.stringify(runIds));
        const response = await fetch("/api/feedback/intake/group-upload", { method: "POST", body: form });
        const payload = await response.json().catch(() => null) as (FeedbackGroupIntakeUploadResponse & { error?: string }) | null;
        if (!response.ok || !payload?.runs || !payload.classes) throw new Error(payload?.error || "导入共同课材料失败");
        acceptGroupIntake(payload);
      } else {
        form.set("sessionCode", entry.sessionCode);
        if (entry.runId && !runs[entry.runId]?.planId) form.set("runId", entry.runId);
        const response = await fetch("/api/feedback/intake/upload", { method: "POST", body: form });
        const payload = await response.json().catch(() => null) as ({ run?: FeedbackIntakeRunClient; error?: string }) | null;
        if (!response.ok || !payload?.run) throw new Error(payload?.error || "导入材料失败");
        acceptRun({ run: payload.run });
      }
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function scanInbox(useExistingFacts = false) {
    if (!entry) return;
    if (contextActionBlocked) {
      setError("课次上下文正在切换，请等当前班级和课次加载完成后再扫描。");
      return;
    }
    setBusy(true); setError(""); setNotice(useExistingFacts ? "正在读取已经确认的课堂事实…" : "正在扫描反馈收件箱…");
    try {
      if (state.draft.mode === "group") {
        const runIds = activeGroupRunIds();
        const result = await requestJson<FeedbackGroupIntakeUploadResponse>("/api/feedback/intake/group-scan", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupLessonId: state.draft.groupLessonId, ...(Object.keys(runIds).length ? { runIds } : {}), ...(useExistingFacts ? { useExistingFacts: true } : {}) }),
        });
        acceptGroupIntake(result);
      } else {
        const result = await requestJson<{ run: FeedbackIntakeRunClient }>("/api/feedback/intake/scan", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionCode: entry.sessionCode, ...(entry.runId && !runs[entry.runId]?.planId ? { runId: entry.runId } : {}), ...(useExistingFacts ? { useExistingFacts: true } : {}) }),
        });
        acceptRun(result);
      }
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function persistSelectedCommonMaterial() {
    if (!commonMaterialChoice.startsWith("library:")) return true;
    const lessonNumber = Number(commonMaterialChoice.slice("library:".length));
    if (!Number.isInteger(lessonNumber) || lessonNumber <= 0) return false;
    if (commonMaterialAction === "unavailable") throw new Error("草稿所选学期材料当前不可用于本课，请改选当前材料或明确不使用。");
    if (commonMaterialAction === "session") {
      if (!context.data?.session) return false;
      await requestJson(`/api/sessions/${encodeURIComponent(context.data.session.id)}/common-material`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonNumber }),
      });
      dispatch({ type: "draft", patch: { materialSelection: { mode: "session_snapshot" }, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
      await context.refresh();
      return true;
    }
    const lesson = context.data?.groupProgress?.lesson;
    if (!lesson) return false;
    await requestJson(`/api/group-lessons/${encodeURIComponent(lesson.id)}/common-material`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonNumber }),
    });
    const result = await requestJson<{ revision: { id: string; revision: number } }>(`/api/group-lessons/${encodeURIComponent(lesson.id)}/confirm`, { method: "POST" });
    dispatch({ type: "draft", patch: { materialSelection: { mode: "linked_revision", revisionId: result.revision.id }, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
    await context.refresh();
    return true;
  }

  function updateDecision(runId: string, decision: FeedbackIntakeDecision) {
    setDecisions((current) => ({ ...current, [runId]: [...(current[runId] ?? []).filter((item) => item.issueId !== decision.issueId), decision] }));
  }

  async function confirmMaterialsAndContinue() {
    if (contextActionBlocked) {
      setError("课次上下文正在切换，请等当前班级和课次加载完成后再确认材料。");
      return;
    }
    const selectedEntries = state.draft.entries.filter((item) => item.selected);
    const actionableUnassigned = unassignedSources.filter(isActionableUnassignedSource);
    const unassignedCount = Math.max(state.draft.unassignedSourceCount, actionableUnassigned.length);
    if (state.draft.mode === "group" && unassignedCount) {
      setError(`还有 ${unassignedCount} 份材料未归入班级或学生，请先处理或明确本轮不采用。`);
      return;
    }
    if (!selectedEntries.length || selectedEntries.some((item) => !item.runId || !runs[item.runId])) {
      setError(state.draft.mode === "group" ? "请先完成共同课一次投料，确保每个真实班级都形成材料运行。" : "请先整理本班材料。");
      return;
    }
    const blockedEntries = selectedEntries.filter((item) => {
      const run = runs[item.runId];
      return run.status !== "applied" && run.issues.some((issue) => isBlockingFeedbackIntakeIssue(issue) && !selectedFeedbackIntakeDecision(issue, decisions[run.id] ?? []));
    });
    if (state.draft.mode === "single" && blockedEntries.length) {
      setError(`${blockedEntries.map((item) => item.className).join("、")}仍有异常尚未处理，请在材料详情中完成核对。`);
      return;
    }
    const confirmableEntries = selectedEntries.filter((item) => runs[item.runId]?.status !== "applied" && !blockedEntries.includes(item));
    if (state.draft.mode === "group" && !confirmableEntries.length && blockedEntries.length) {
      setError(`${blockedEntries.map((item) => item.className).join("、")}仍有异常尚未处理；先核对其中一班，已完成班级不会被撤销。`);
      return;
    }
    setBusy(true); setError(""); setNotice("正在确认课程材料并写入各班课堂事实…");
    try {
      if (forcedInheritedMaterial && availableMaterial) {
        dispatch({ type: "draft", patch: { materialSelection: availableMaterial, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
      }
      if (!(await persistSelectedCommonMaterial())) return;
      const targets = confirmableEntries;
      const settled = await Promise.allSettled(targets.map((item) => requestJson<{ result: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(item.runId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", decisions: decisions[item.runId] ?? [] }),
      })));
      const completed = settled.flatMap((result) => result.status === "fulfilled" ? [result.value.result] : []);
      setRuns((current) => Object.assign({}, current, ...completed.map((run) => ({ [run.id]: run }))));
      const failedEntries = targets.filter((_, index) => settled[index]?.status === "rejected");
      const remainingEntries = [...blockedEntries, ...failedEntries];
      if (remainingEntries.length) {
        const failures = failedEntries.map((item) => {
          const index = targets.indexOf(item);
          const result = settled[index];
          const reason = result?.status === "rejected" ? errorMessage(result.reason) : "材料确认失败";
          return `${item.className}：${reason}`;
        });
        const pending = blockedEntries.length ? `${blockedEntries.map((item) => item.className).join("、")}仍需核对` : "";
        const failed = failures.length ? failures.join("；") : "";
        setError(`共同录入还有班级未完成。${[pending, failed].filter(Boolean).join("；")}`);
        const alreadyApplied = selectedEntries.length - targets.length - blockedEntries.length;
        setNotice(`已有 ${alreadyApplied + completed.length} 个班分别写入事实；未完成班级可以继续处理和重试。`);
        return;
      }
      dispatch({ type: "stage", stage: "confirm" });
      setNotice(state.draft.mode === "group" ? `共同录入完成：${selectedEntries.length} 个班的事实已经分别写入。` : "材料与课堂事实已确认；现在选择学生并建立本班反馈计划。");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function clearScopes() {
    setBusy(true); setError("");
    try {
      const targets = state.draft.entries.filter((item) => item.selected && item.runId);
      const results = await Promise.all(targets.map((item) => requestJson<{ result: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(item.runId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear_scope" }) })));
      setRuns((current) => Object.assign({}, current, ...results.map((result) => ({ [result.result.id]: result.result }))));
      dispatch({ type: "stage", stage: "prepare" });
      setNotice("已清除本轮班级范围；已确认课堂事实仍保留。 ");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function createTaskRequest() {
    const selectedEntries = state.draft.entries.filter((item) => item.selected && item.runId);
    const entryBySession = new Map(selectedEntries.map((item) => [item.sessionCode, item]));
    const classOverrides = state.draft.mode === "group" ? state.draft.classOverrides.flatMap((override) => {
      const target = entryBySession.get(override.sessionCode);
      if (!target?.runId) return [];
      const outputRequirement = override.outputRequirement?.trim();
      if (!outputRequirement && !override.preferences) return [];
      return [{
        runId: target.runId,
        ...(outputRequirement ? { outputRequirement } : {}),
        ...(override.preferences ? { preferences: { ...state.draft.preferences, ...override.preferences } } : {}),
      }];
    }) : [];
    const selectedStudentIds = new Set(selectedEntries.flatMap((item) => item.studentIds));
    const studentOverrides = state.draft.studentOverrides.filter((override) => selectedStudentIds.has(override.studentId));
    const result = await requestJson<{ taskType: "plan" | "batch"; planId: string | null; firstPlanId?: string | null; batchId: string | null; generationStatus: string; warning?: string }>("/api/feedback/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestKey: state.draft.requestKey,
          mode: state.draft.mode,
          ...(state.draft.mode === "group" ? { groupLessonId: state.draft.groupLessonId } : {}),
          runIds: selectedEntries.map((item) => item.runId),
          generationMode: state.draft.generationMode,
          outputRequirement: state.draft.outputRequirement,
          materialSelection: state.draft.materialSelection,
          preferences: state.draft.preferences,
          ...(classOverrides.length ? { classOverrides } : {}),
          ...(studentOverrides.length ? { studentOverrides } : {}),
        }),
    });
    const planId = result.planId ?? result.firstPlanId ?? "";
    if (planId && selectedEntries.length === 1) {
      const runId = selectedEntries[0]!.runId;
      setRuns((current) => current[runId] ? { ...current, [runId]: { ...current[runId], planId } } : current);
    }
    groupModeSnapshotRef.current = null;
    dispatch({ type: "task", planId, batchId: result.batchId ?? "" });
    taskUrl({ planId, batchId: result.batchId ?? "" });
    clearFeedbackTaskDraft(draftScope);
    setNotice(result.generationStatus === "start_failed"
      ? `规划已保存并进入生成。${result.warning ?? "生成尚未启动，可在第三步重试。"}`
      : result.generationStatus === "existing"
        ? "已打开现有反馈任务。"
        : "规划已保存，已进入生成与复核。 ");
  }

  async function confirmScopeAndCreate() {
    if (contextActionBlocked) {
      setError("课次上下文正在切换，请等当前班级和课次加载完成后再创建任务。");
      return;
    }
    const selectedEntries = state.draft.entries.filter((item) => item.selected && item.runId);
    const emptyClasses = selectedEntries.filter((item) => item.studentIds.length === 0);
    if (!selectedEntries.length || emptyClasses.length) {
      setError(emptyClasses.length ? `${emptyClasses.map((item) => item.className).join("、")}至少需要选择一名学生。` : "请先选择反馈班级与学生。");
      return;
    }
    if (selectedEntries.some((item) => runs[item.runId]?.status !== "applied")) {
      setError("材料与课堂事实尚未全部确认，请返回材料审核。");
      return;
    }
    setBusy(true); setError(""); setNotice("正在保存有变化的班级范围…");
    try {
      const targets = selectedEntries.filter((item) => !scopeMatchesEntry(item, runs[item.runId]));
      const settled = await Promise.allSettled(targets.map((item) => requestJson<{ result: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(item.runId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm_scope", scope: { classId: item.classId, sessionCode: item.sessionCode, studentIds: item.studentIds } }),
      })));
      const completed = settled.flatMap((result) => result.status === "fulfilled" ? [result.value.result] : []);
      setRuns((current) => Object.assign({}, current, ...completed.map((run) => ({ [run.id]: run }))));
      const failedEntries = targets.filter((_, index) => settled[index]?.status === "rejected");
      if (failedEntries.length) {
        setError(`${failedEntries.map((item) => item.className).join("、")}的反馈范围保存失败，尚未创建任务；重试只会补未完成部分。`);
        setNotice(`已保存 ${completed.length} 个班的范围。`);
        return;
      }
      setNotice("范围已保存，正在创建任务并启动生成…");
      await createTaskRequest();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  function changeStudioPlan(next: FeedbackStudioPlanTarget) {
    dispatch({ type: "task", planId: next.id, batchId: state.batchId });
    taskUrl({ planId: next.id, batchId: state.batchId });
    context.switchSession(next);
  }

  async function endAndStartNew() {
    const kind = state.batchId ? "feedback-plan-batches" : "feedback-plans";
    const id = state.batchId || state.planId;
    if (!id || !window.confirm("结束并归档当前任务，再建立一轮新任务吗？课堂事实和历史正文会保留。")) return;
    setBusy(true); setError("");
    try {
      if (state.batchId) {
        const current = await requestJson<{ batch: { status: string } }>(`/api/report/feedback-plan-batches/${encodeURIComponent(id)}`);
        if (["queued", "running", "pause_requested"].includes(current.batch.status)) {
          await requestJson(`/api/report/feedback-plan-batches/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pause" }) });
          for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            const polled = await requestJson<{ batch: { status: string } }>(`/api/report/feedback-plan-batches/${encodeURIComponent(id)}`);
            if (!["queued", "running", "pause_requested"].includes(polled.batch.status)) break;
            if (attempt === 39) throw new Error("班级组仍在安全暂停，请稍后重试");
          }
        }
      } else {
        const current = await requestJson<{ plan: { status: string } }>(`/api/report/feedback-plans/${encodeURIComponent(id)}`);
        if (["queued", "generating", "pause_requested"].includes(current.plan.status)) {
          await requestJson(`/api/report/feedback-plans/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pause_generation" }) });
          for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            const polled = await requestJson<{ plan: { status: string } }>(`/api/report/feedback-plans/${encodeURIComponent(id)}`);
            if (!["queued", "generating", "pause_requested"].includes(polled.plan.status)) break;
            if (attempt === 39) throw new Error("计划仍在安全暂停，请稍后重试");
          }
        }
      }
      await requestJson(`/api/report/${kind}/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive" }) });
      await clearScopes();
      groupModeSnapshotRef.current = null;
      restoredFromStorage.current = false;
      dispatch({ type: "task", planId: "", batchId: "" });
      dispatch({ type: "restore", draft: createFeedbackTaskDraft() });
      dispatch({ type: "stage", stage: "prepare" });
      taskUrl({ planId: "", batchId: "" });
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  const currentRun = entry?.runId ? runs[entry.runId] ?? null : null;
  const material = context.data?.groupProgress?.lesson?.confirmedMaterial ?? context.data?.sessionCommonMaterial?.material;
  const availableMaterial = context.data?.groupProgress?.status === "linked" && context.data.groupProgress.lesson?.revisions?.[0]
    ? { mode: "linked_revision" as const, revisionId: context.data.groupProgress.lesson.revisions[0].id }
    : context.data?.sessionCommonMaterial?.confirmedAt ? { mode: "session_snapshot" as const } : null;
  const materialLabel = context.data?.groupProgress?.lesson
    ? context.data.groupProgress.lesson.revisions[0]
      ? `班级组第 ${context.data.groupProgress.lesson.sequence} 讲 · 已确认修订 ${context.data.groupProgress.lesson.revision}`
      : lessonMaterialHasContent(context.data.groupProgress.lesson.draftMaterial)
        ? `班级组第 ${context.data.groupProgress.lesson.sequence} 讲 · 公共材料草稿待确认`
        : `班级组第 ${context.data.groupProgress.lesson.sequence} 讲 · 尚未选择公共材料`
    : context.data?.sessionCommonMaterial?.confirmedAt
      ? "当前独立课次已确认公共材料"
      : "当前独立课次尚未保存公共材料";
  const libraryMaterialOptions = (scriptLibrary.library?.entries ?? []).map((item) => ({
    value: `library:${item.lessonNumber}`,
    label: `第 ${item.lessonNumber} 课${item.topic ? ` · ${item.topic}` : ""}`,
    preview: item.material?.groupFeedbackRaw ?? item.groupFeedback,
  }));
  const groupProgress = context.data?.groupProgress;
  const commonMaterialAction = groupProgress?.status === "linked"
    ? (groupProgress.isLeadClass ? "group" as const : "unavailable" as const)
    : groupProgress?.status === "lead_required" ? "unavailable" as const : "session" as const;
  const commonMaterialHelp = groupProgress?.status === "linked"
    ? groupProgress.isLeadClass
      ? `当前为进度基准班的共同第 ${groupProgress.lesson?.sequence ?? "-"} 讲；改选学期材料后需确认共享，其他班才能继承。`
      : `本班已关联共同第 ${groupProgress.lesson?.sequence ?? "-"} 讲；可使用该讲已确认材料，或明确选择本次不使用。`
    : groupProgress?.status === "lead_required"
      ? "当前班级组尚未指定进度基准班，请先在学期管理中完成组设置。"
      : groupProgress?.group
        ? "当前真实课次未关联共同讲次；所选材料将在进入核对时保存为本课材料。"
        : "选择学期材料后，进入核对时会自动保存为本课材料并用于本次反馈。";
  const commonMaterialOptions = [
    { value: "none", label: "本次不使用公共材料" },
    ...(availableMaterial ? [{ value: "current", label: "使用当前课次已确认公共材料" }] : []),
    ...(commonMaterialAction === "unavailable" ? [] : libraryMaterialOptions.map(({ value, label }) => ({ value, label }))),
  ];
  const resolvedMaterialChoice = resolveFeedbackTaskMaterialChoice(state.draft, availableMaterial);
  const forcedInheritedMaterial = commonMaterialAction === "unavailable"
    && Boolean(availableMaterial)
    && resolvedMaterialChoice.value.startsWith("library:");
  const commonMaterialChoice = forcedInheritedMaterial ? "current" : resolvedMaterialChoice.value;
  if (resolvedMaterialChoice.historicalLabel && !commonMaterialOptions.some((option) => option.value === commonMaterialChoice)) {
    commonMaterialOptions.splice(availableMaterial ? 2 : 1, 0, { value: commonMaterialChoice, label: resolvedMaterialChoice.historicalLabel });
  } else if (commonMaterialChoice.startsWith("library:") && !commonMaterialOptions.some((option) => option.value === commonMaterialChoice)) {
    commonMaterialOptions.push({ value: commonMaterialChoice, label: `草稿所选第 ${commonMaterialChoice.slice("library:".length)} 课（当前材料库中不可用）` });
  }
  const selectedMaterialPreview = commonMaterialChoice === "current"
    ? material?.groupFeedbackRaw ?? ""
    : libraryMaterialOptions.find((item) => item.value === commonMaterialChoice)?.preview ?? "";

  function selectCommonMaterial(choice: string) {
    if (choice === "none") dispatch({ type: "draft", patch: { materialSelection: { mode: "none" }, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
    else if (choice === "current" && availableMaterial) dispatch({ type: "draft", patch: { materialSelection: availableMaterial, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
    else if (choice.startsWith("library:")) {
      const lessonNumber = Number(choice.slice("library:".length));
      if (Number.isInteger(lessonNumber) && lessonNumber > 0) dispatch({ type: "draft", patch: { materialSelection: { mode: "none" }, materialSelectionInitialized: true, pendingMaterialLessonNumber: lessonNumber } });
    }
  }

  const selectedEntries = state.draft.entries.filter((item) => item.selected);
  const actionableUnassignedSources = unassignedSources.filter(isActionableUnassignedSource);
  const actionableUnassignedCount = Math.max(state.draft.unassignedSourceCount, actionableUnassignedSources.length);
  const allSelectedRunsApplied = selectedEntries.length > 0
    && selectedEntries.every((item) => runs[item.runId]?.status === "applied");
  const unresolvedBlockingCount = selectedEntries.reduce((total, item) => {
    const run = runs[item.runId];
    if (!run || run.status === "applied") return total;
    return total + run.issues.filter(isBlockingFeedbackIntakeIssue).filter((issue) => !selectedFeedbackIntakeDecision(issue, decisions[run.id] ?? [])).length;
  }, 0);
  const groupMaterialSummary: GroupMaterialSummary | undefined = state.draft.mode === "group" ? {
    title: "本轮材料",
    scopeLabel: `${selectedEntries.length} 个班 · ${selectedEntries.reduce((total, item) => total + item.studentIds.length, 0)} 名学生`,
    issueCount: unresolvedBlockingCount + actionableUnassignedCount,
    issues: actionableUnassignedSources.length
      ? actionableUnassignedSources.map((item) => ({ message: `${item.fileName}：${item.reason}` }))
      : actionableUnassignedCount
        ? [{ message: `上次保存的任务还有 ${actionableUnassignedCount} 份未归属材料；可以重新投料，或明确本轮不采用。` }]
        : [],
    sources: (["assistant_roster", "step_classroom", "assessment_pdf"] as const).map((kind) => {
      const summary = sourceSummaries.find((item) => item.kind === kind);
      const files = [...new Set(selectedEntries.flatMap((item) => (runs[item.runId]?.sourceManifest ?? []).filter((source) => source.kind === kind).map((source) => source.name ?? "未命名文件")))];
      const fileNames = new Set(files);
      const runIssues = selectedEntries.flatMap((item) => {
        const run = runs[item.runId];
        if (!run || run.status === "applied") return [];
        return run.issues.filter((issue) => issue.sourceName && fileNames.has(issue.sourceName) && isBlockingFeedbackIntakeIssue(issue)).map((issue) => ({
          id: issue.id,
          code: issue.code,
          message: issue.message,
          runId: run.id,
          className: item.className,
          sourceName: issue.sourceName,
          candidates: issue.candidates,
          stage: issue.stage,
          rowNumber: issue.rowNumber,
          reportedStudent: issue.reportedStudent,
          rosterHint: issue.rosterHint,
          decision: selectedFeedbackIntakeDecision(issue, decisions[run.id] ?? []),
        }));
      });
      const sourceIssues = [...runIssues, ...actionableUnassignedSources
        .filter((item) => item.kind === kind)
        .map((item) => ({ message: `${item.fileName}：${item.reason}` }))];
      const unresolvedIssueCount = runIssues.filter((issue) => !issue.decision).length + sourceIssues.length - runIssues.length;
      const status = unresolvedIssueCount > 0
        ? "needs_review" as const
        : !summary || summary.status === "empty"
        ? "missing" as const
        : summary.status === "complete"
          ? allSelectedRunsApplied ? "applied" as const : "ready" as const
          : "needs_review" as const;
      const assistantFacts = kind === "assistant_roster" ? selectedEntries.flatMap((item) => {
        const run = runs[item.runId];
        return (run?.appliedSummary.sourceFacts ?? []).filter((fact) => fact.kind === "assistant_roster" && files.includes(fact.key));
      }) : [];
      const matchedAssistantStudents = assistantFacts.reduce((total, fact) => total + (fact.assistantMatch?.matchedStudents
        ?? fact.parsedResult?.students?.filter((student) => student.present !== false).length
        ?? 0), 0);
      const totalAssistantRows = assistantFacts.reduce((total, fact) => total + (fact.assistantMatch?.totalStudentRows
        ?? (fact.parsedResult?.students?.filter((student) => student.present !== false).length ?? 0) + (fact.unresolvedStudents?.length ?? 0)), 0);
      const sessionState = runIssues.some((issue) => issue.code === "assistant_date_mismatch" || issue.code === "assistant_lesson_mismatch")
        ? "课次待确认"
        : runIssues.some((issue) => issue.code === "assistant_date_missing" || issue.code === "assistant_lesson_missing")
          ? "课次信息不完整"
          : "课次已匹配";
      return {
        kind,
        fileCount: summary?.fileCount ?? files.length,
        issueCount: unresolvedIssueCount,
        status,
        files,
        issues: sourceIssues,
        matched: summary ? (summary.kind === "assessment_pdf" ? summary.matchedStudents : summary.matchedClasses) : 0,
        total: summary ? (summary.kind === "assessment_pdf" ? summary.totalStudents : summary.totalClasses) : kind === "assessment_pdf" ? selectedEntries.reduce((total, item) => total + item.studentIds.length, 0) : selectedEntries.length,
        unit: kind === "assessment_pdf" ? "名学生" as const : "个班" as const,
        matchText: kind === "assistant_roster" && files.length
          ? `班级 ${summary?.kind === "assistant_roster" ? summary.matchedClasses : 0}/${selectedEntries.length} · 学生 ${matchedAssistantStudents}/${totalAssistantRows} · ${sessionState}`
          : undefined,
      };
    }),
  } : undefined;

  const manualFactsHref = `/feedback/tools?${new URLSearchParams({
    tool: "manual-facts",
    semesterId: context.context.semesterId,
    class: context.context.className,
    classId: context.context.classId ?? "",
    sessionCode: context.context.sessionCode,
  })}`;

  return <main className={styles.page}>
    <PageHeader title="课后任务" description="共同课可以一次录入；事实确认后，每个班仍按熟悉的单班流程建立、生成和复核反馈。" actions={<div className={styles.headerActions}><Badge tone="info">{packageMetadata.version}</Badge><Link className="ui-button ui-button--ghost ui-button--md" href="/feedback/tools">高级工具</Link></div>} />
    <details><summary>当前反馈任务</summary><FeedbackPlanManager semesterId={context.context.semesterId} /></details>
    {(error || context.error) && <StatusBanner tone="danger">{error || context.error}</StatusBanner>}{notice && <StatusBanner tone="info">{notice}</StatusBanner>}
    {state.stage !== "studio" && <section className={styles.taskCard}>
      {state.stage === "prepare" && <div className="feedback-context-section"><SemesterPicker semesterId={context.context.semesterId} onSemesterChange={context.setSemesterId} classId={context.context.classId} className={context.context.className} onClassChange={context.setClass} sessionCode={context.context.sessionCode} onSessionChange={context.setSessionCode} refreshKey={context.refreshKey} /><div className="feedback-new-session"><Button variant="secondary" onClick={() => setSessionDialogOpen(true)} disabled={!context.context.semesterId || !context.context.classId}>新建真实课次</Button></div></div>}
      {state.stage === "prepare" && groupAvailable && groupLesson && group && <section className={styles.groupScope}><header><div><strong>{state.draft.mode === "group" ? "共同课批量录入" : "当前按本班反馈"}</strong><span>{group.name} · 第 {groupLesson.sequence} 讲 · {realGroupMembers.length} 个真实班级</span></div><Button variant={state.draft.mode === "group" ? "ghost" : "secondary"} onClick={() => setTaskMode(state.draft.mode === "group" ? "single" : "group")}>{state.draft.mode === "group" ? "返回本班反馈" : "共同课批量录入"}</Button></header><p>{state.draft.mode === "group" ? "这里只做一次投料、按班核对和分别写入；完成后再逐班建立反馈计划。" : "默认只处理当前班级。需要给同讲次多个班一起录入时，再进入批量录入。"}</p>{state.draft.mode === "group" && <div className={styles.groupClasses}>{state.draft.entries.map((item) => {
        const run = item.runId ? runs[item.runId] : undefined;
        const blocking = run?.status === "applied" ? 0 : run?.issues.filter((issue) => isBlockingFeedbackIntakeIssue(issue) && !selectedFeedbackIntakeDecision(issue, decisions[run.id] ?? [])).length ?? 0;
        const label = loadingGroupRosters && !studentsBySession[item.sessionCode] ? "读取花名册" : run?.status === "applied" ? "事实已写入" : run ? blocking ? `${blocking} 项待核对` : "可以确认" : "等待共同投料";
        return <article key={item.sessionCode} className={item.sessionCode === entry?.sessionCode ? styles.groupClassActive : ""}><div><strong>{item.className}</strong><small>{item.sessionCode} · {studentsBySession[item.sessionCode]?.length ?? item.studentIds.length} 人</small></div><div><Badge tone={run?.status === "applied" ? "success" : "warning"}>{label}</Badge><Button uiSize="sm" variant="ghost" onClick={() => dispatch({ type: "draft", patch: { activeSessionCode: item.sessionCode } })}>核对此班</Button></div></article>;
      })}</div>}</section>}
      <nav className={styles.taskRail} aria-label="反馈任务阶段"><button type="button" className={state.stage === "prepare" ? styles.activeRail : ""} onClick={() => dispatch({ type: "stage", stage: "prepare" })}><span>1</span><strong>录入</strong><small>{state.draft.mode === "group" ? "共同投料、逐班核验" : "材料可选、事实确认"}</small></button><button type="button" className={state.stage === "confirm" ? styles.activeRail : ""} disabled={!allSelectedRunsApplied || contextActionBlocked} onClick={() => dispatch({ type: "stage", stage: "confirm" })}><span>2</span><strong>规划</strong><small>{state.draft.mode === "group" ? "多班范围与例外" : "学生范围与反馈要求"}</small></button><button type="button" disabled><span>3</span><strong>生成</strong><small>{state.draft.mode === "group" ? "按班进度与局部重试" : "生成、复核与批准"}</small></button></nav>
      {entry && state.stage === "prepare" && <TaskPreparationStage draft={state.draft} entry={entry} run={currentRun} studentTotal={state.draft.mode === "group" ? selectedEntries.reduce((total, item) => total + (studentsBySession[item.sessionCode]?.length ?? item.studentIds.length), 0) : studentsBySession[entry.sessionCode]?.length ?? entry.studentIds.length} busy={busy || loadingGroupRosters || loadingSingleRoster || contextActionBlocked} confirmDisabled={contextActionBlocked || !selectedEntries.length || selectedEntries.some((item) => !item.runId || !runs[item.runId]) || actionableUnassignedCount > 0 || (state.draft.mode === "single" && unresolvedBlockingCount > 0)} commonMaterialLabel={materialLabel} commonMaterialPreview={selectedMaterialPreview} commonMaterialOptions={commonMaterialOptions} commonMaterialChoice={commonMaterialChoice} commonMaterialAction={commonMaterialAction} commonMaterialHelp={commonMaterialHelp} decisions={currentRun ? decisions[currentRun.id] ?? [] : []} materialSummary={groupMaterialSummary} manualFactsHref={manualFactsHref} onIgnoreUnassigned={state.draft.mode === "group" && actionableUnassignedCount ? ignoreUnassignedSources : undefined} onDecision={updateDecision} onCommonMaterialChoice={selectCommonMaterial} onFiles={(files) => void uploadFiles(files)} onScan={() => void scanInbox()} onUseExistingFacts={() => void scanInbox(true)} onContinue={() => void confirmMaterialsAndContinue()} />}
      {entry && state.stage === "confirm" && <TaskConfirmationStage draft={state.draft} studentsBySession={studentsBySession} scopeSummary={state.draft.mode === "group" ? `${group?.name ?? "共同课"} · 第 ${groupLesson?.sequence ?? "-"} 讲 · ${selectedEntries.map((item) => item.className).join("、")}` : `${entry.className} · ${entry.sessionCode}`} busy={busy || loadingGroupRosters || loadingSingleRoster || contextActionBlocked} onEntry={(sessionCode, patch) => dispatch({ type: "entry", sessionCode, patch })} onDraft={(patch) => dispatch({ type: "draft", patch })} onClassOverrideChange={(sessionCode, override) => dispatch({ type: "class-override", sessionCode, override })} onStudentOverrideChange={(studentId, generationConfig) => dispatch({ type: "student-override", studentId, generationConfig })} onBack={() => dispatch({ type: "stage", stage: "prepare" })} onStart={() => void confirmScopeAndCreate()} />}
      {!entry && <StatusBanner tone="warning">请先选择真实课次。</StatusBanner>}
    </section>}
    {state.stage === "studio" && <FeedbackTaskStudioStage semesterId={context.context.semesterId} className={context.context.className} sessionCode={context.context.sessionCode} planId={state.planId} batchId={state.batchId} context={context.data} onPlanChange={changeStudioPlan} onNewTask={() => void endAndStartNew()} />}
    <SessionDialog
      open={sessionDialogOpen}
      semesterId={context.context.semesterId}
      classId={context.context.classId}
      className={context.context.className}
      onClose={() => setSessionDialogOpen(false)}
      onSaved={(session) => {
        context.setSessionCode(session.code);
        context.refresh();
      }}
    />
  </main>;
}
