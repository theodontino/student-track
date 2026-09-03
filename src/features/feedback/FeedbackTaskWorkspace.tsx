"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
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
import FeedbackPlanManager, { type ArchivedFeedbackTaskReference, type FeedbackTaskOpenTarget } from "./FeedbackPlanManager";
import { TaskPreparationStage, type GroupMaterialSummary } from "./TaskPreparationStage";
import { TaskConfirmationStage } from "./TaskConfirmationStage";
import { FeedbackTaskStudioStage } from "./FeedbackTaskStudioStage";
import { FeedbackTaskDocumentStage } from "./FeedbackTaskDocumentStage";
import type { FeedbackContextStudent } from "./context-types";
import type { FeedbackContextResponse } from "./types";
import {
  dismissFeedbackGroupUnassignedSourcesForSelectedClasses,
  scopeFeedbackGroupUnassignedSources,
} from "./feedback-group-unassigned";
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
  feedbackTaskStageForView,
  feedbackTaskViewForStage,
  resolveFeedbackTaskMaterialChoice,
  type FeedbackTaskClassDraft,
  type FeedbackTaskCurrentFactsSeed,
  type FeedbackTaskDraftV2,
  type FeedbackTaskGroupSnapshot,
  type FeedbackTaskState,
  type MaterialSelection,
} from "./feedback-task-state";
import {
  clearFeedbackTaskDraft,
  feedbackTaskDraftScopeKey,
  readFeedbackTaskDraft,
  readFeedbackTaskStartupDraft,
  syncFeedbackTaskSingleDraftGroupSnapshots,
  useFeedbackTaskDraftPersistence,
  writeFeedbackTaskDraft,
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
  return students
    .filter((student) => (student.feedbackRecommendationReasons?.length ?? 0) > 0 || student.id in assessmentEvidence)
    .map((student) => student.id);
}

export function defaultFeedbackStudentIds(
  students: Array<Pick<FeedbackContextStudent, "id" | "feedbackRecommendationReasons">>,
  assessmentEvidence: Record<string, unknown> = {},
) {
  const recommendedIds = recommendedFeedbackStudentIds(students, assessmentEvidence);
  return recommendedIds.length ? recommendedIds : students.map((student) => student.id);
}

export function refreshAutomaticFeedbackStudentSelection(
  entry: FeedbackTaskClassDraft,
  students: Array<Pick<FeedbackContextStudent, "id" | "feedbackRecommendationReasons">>,
  assessmentEvidence: Record<string, unknown> = {},
) {
  const availableIds = new Set(students.map((student) => student.id));
  const studentIds = entry.studentSelectionInitialized
    ? entry.studentIds.filter((studentId) => availableIds.has(studentId))
    : defaultFeedbackStudentIds(students, assessmentEvidence);
  if (
    studentIds.length === entry.studentIds.length
    && studentIds.every((studentId, index) => studentId === entry.studentIds[index])
  ) return entry;
  return { ...entry, studentIds };
}

export function refreshFeedbackStudentSelections(
  entries: FeedbackTaskClassDraft[],
  studentsBySession: Record<string, Array<Pick<FeedbackContextStudent, "id" | "feedbackRecommendationReasons">>>,
  runs: Record<string, Pick<FeedbackIntakeRunClient, "appliedSummary">>,
) {
  return entries.map((item) => {
    if (item.studentSelectionInitialized) return item;
    const students = studentsBySession[item.sessionCode];
    if (!students) return item;
    return refreshAutomaticFeedbackStudentSelection(
      item,
      students,
      item.runId ? runs[item.runId]?.appliedSummary.assessmentEvidence : {},
    );
  });
}

export function feedbackGroupIntakeScope(
  entries: FeedbackTaskClassDraft[],
  runs: Record<string, Pick<FeedbackIntakeRunClient, "planId"> | undefined>,
  plannedSessionCodes: Iterable<string> = [],
) {
  const planned = new Set(plannedSessionCodes);
  const selectedEntries = entries.filter((item) => (
    item.selected && !planned.has(item.sessionCode)
  ));
  return {
    sessionCodes: selectedEntries.map((item) => item.sessionCode),
    runIds: Object.fromEntries(selectedEntries.flatMap((item) => (
      // A linked run can seed another plan, but adding new material must start
      // an independent intake run so the historical fact snapshot stays frozen.
      item.runId && !runs[item.runId]?.planId ? [[item.sessionCode, item.runId]] : []
    ))),
  };
}

export function createFeedbackTaskFollowUpDraft(
  draft: FeedbackTaskDraftV2,
  newlyPlannedSessionCodes: Iterable<string>,
): FeedbackTaskDraftV2 | null {
  if (draft.mode !== "group") return null;
  const planned = new Set([...draft.plannedSessionCodes, ...newlyPlannedSessionCodes]);
  const unfinishedEntries = draft.entries.filter((item) => !planned.has(item.sessionCode));
  if (!unfinishedEntries.length) return null;
  const unfinishedSessions = new Set(unfinishedEntries.map((item) => item.sessionCode));
  const unfinishedStudents = new Set(unfinishedEntries.flatMap((item) => item.studentIds));
  return {
    ...draft,
    setupStage: "prepare",
    requestKey: crypto.randomUUID(),
    activeSessionCode: unfinishedEntries[0]!.sessionCode,
    entries: draft.entries.map((item) => ({ ...item, selected: !planned.has(item.sessionCode) })),
    plannedSessionCodes: [...planned],
    classOverrides: draft.classOverrides.filter((override) => unfinishedSessions.has(override.sessionCode)),
    studentOverrides: draft.studentOverrides.filter((override) => unfinishedStudents.has(override.studentId)),
    groupSnapshot: null,
  };
}

export function feedbackTaskGroupDraftForFollowUp(
  draft: FeedbackTaskDraftV2,
  storedGroupDraft: FeedbackTaskDraftV2 | null = null,
): FeedbackTaskDraftV2 | null {
  if (draft.mode === "group") return draft;
  const snapshot = draft.groupSnapshot;
  if (!snapshot) return null;
  const base = storedGroupDraft?.mode === "group" && storedGroupDraft.groupLessonId === snapshot.groupLessonId
    ? storedGroupDraft
    : draft;
  const currentEntries = new Map(draft.entries.map((item) => [item.sessionCode, item]));
  return {
    ...base,
    mode: "group",
    groupLessonId: snapshot.groupLessonId,
    activeSessionCode: snapshot.activeSessionCode,
    entries: snapshot.entries.map((item) => currentEntries.get(item.sessionCode) ?? item),
    plannedSessionCodes: [...new Set([...base.plannedSessionCodes, ...snapshot.plannedSessionCodes])],
    unassignedSourceCount: snapshot.unassignedSourceCount,
    unassignedSources: snapshot.unassignedSources,
    groupSnapshot: null,
  };
}

export function feedbackTaskGroupRestoreAttemptKey(
  scope: Pick<FeedbackTaskDraftScope, "semesterId" | "classId" | "sessionCode">,
  groupLessonId: string,
) {
  return `${feedbackTaskDraftScopeKey({ ...scope, groupLessonId })}:${scope.classId}:${scope.sessionCode}`;
}

export function feedbackTaskOperationScopeToken(
  semesterId: string,
  draft: FeedbackTaskDraftV2,
  plannedSessionCodes: Iterable<string> = [],
  navigation: { stage: string; planId: string; batchId: string } = { stage: "", planId: "", batchId: "" },
) {
  const location = [navigation.stage, navigation.planId, navigation.batchId];
  if (draft.mode === "group") {
    const planned = new Set(plannedSessionCodes);
    const selectedSessions = draft.entries
      .filter((item) => item.selected && !planned.has(item.sessionCode))
      .map((item) => item.sessionCode)
      .sort();
    return JSON.stringify([semesterId, "group", draft.groupLessonId, selectedSessions, ...location]);
  }
  const active = draft.entries.find((item) => item.sessionCode === draft.activeSessionCode) ?? draft.entries[0];
  return JSON.stringify([semesterId, "single", active?.classId ?? "", active?.sessionCode ?? "", ...location]);
}

export function selectedFeedbackTaskStudentOverrides(
  draft: FeedbackTaskDraftV2,
  selectedEntries = draft.entries.filter((item) => item.selected && !draft.plannedSessionCodes.includes(item.sessionCode)),
) {
  const selectedStudentIds = new Set(
    selectedEntries.flatMap((item) => item.studentIds),
  );
  return draft.studentOverrides.filter((override) => selectedStudentIds.has(override.studentId));
}

export function releaseArchivedFeedbackTaskReferences(
  runs: Record<string, FeedbackIntakeRunClient>,
  plannedSessionCodes: string[],
  archived: ArchivedFeedbackTaskReference,
) {
  const archivedPlanIds = new Set(archived.planIds);
  const archivedSessionCodes = new Set(archived.sessionCodes);
  return {
    runs: Object.fromEntries(Object.entries(runs).map(([runId, run]) => [
      runId,
      run.planId && archivedPlanIds.has(run.planId) ? { ...run, planId: null } : run,
    ])),
    plannedSessionCodes: plannedSessionCodes.filter((sessionCode) => !archivedSessionCodes.has(sessionCode)),
  };
}

export function partitionFeedbackIntakeConfirmationEntries(
  entries: FeedbackTaskClassDraft[],
  runs: Record<string, FeedbackIntakeRunClient>,
  decisions: Record<string, FeedbackIntakeDecision[]>,
) {
  const alreadyAppliedEntries = entries.filter((item) => runs[item.runId]?.status === "applied");
  const blockedEntries = entries.filter((item) => {
    const run = runs[item.runId];
    return Boolean(run && run.status !== "applied" && run.issues.some((issue) => (
      isBlockingFeedbackIntakeIssue(issue) && !selectedFeedbackIntakeDecision(issue, decisions[run.id] ?? [])
    )));
  });
  const confirmableEntries = entries.filter((item) => (
    runs[item.runId]?.status !== "applied" && !blockedEntries.includes(item)
  ));
  return { alreadyAppliedEntries, blockedEntries, confirmableEntries };
}

export function feedbackIntakeConfirmationOutcome(
  targets: FeedbackTaskClassDraft[],
  settled: PromiseSettledResult<{ result: FeedbackIntakeRunClient }>[],
) {
  return {
    completed: settled.flatMap((result) => result.status === "fulfilled" ? [result.value.result] : []),
    failedEntries: targets.filter((_, index) => settled[index]?.status === "rejected"),
  };
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
  for (const source of incoming) {
    const key = `${source.kind}\u0000${source.fileName}`;
    const previous = merged.get(key);
    if (previous && isActionableUnassignedSource(previous) && !isActionableUnassignedSource(source)) continue;
    merged.set(key, source);
  }
  return [...merged.values()];
}

export function mergeLoadedGroupRosterEntries(
  entries: FeedbackTaskClassDraft[],
  studentIdsBySession: Map<string, string[]>,
) {
  return entries.map((item) => {
    if (!studentIdsBySession.has(item.sessionCode)) return item;
    const validIds = new Set(studentIdsBySession.get(item.sessionCode));
    const selectedIds = item.studentIds.filter((id) => validIds.has(id));
    return selectedIds.length === item.studentIds.length && selectedIds.every((id, index) => id === item.studentIds[index])
      ? item
      : { ...item, studentIds: selectedIds };
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
    studentSelectionInitialized: previous.get(member.session.code)?.studentSelectionInitialized ?? false,
    selected: previous.get(member.session.code)?.selected ?? true,
  } satisfies FeedbackTaskClassDraft] : []);
  return {
    entries,
    activeSessionCode: saved?.activeSessionCode ?? "",
    plannedSessionCodes: saved?.plannedSessionCodes ?? [],
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

export function feedbackGroupMaterialSourceStatus(input: {
  summaryStatus?: FeedbackGroupIntakeSourceSummary["status"];
  unresolvedIssueCount: number;
  allSelectedRunsApplied: boolean;
}): "missing" | "ready" | "needs_review" | "applied" {
  if (input.unresolvedIssueCount > 0) return "needs_review";
  if (!input.summaryStatus || input.summaryStatus === "empty") return "missing";
  return input.allSelectedRunsApplied ? "applied" : "ready";
}

export function rebuildGroupSourceSummaries(
  entries: FeedbackTaskClassDraft[],
  runs: Record<string, FeedbackIntakeRunClient>,
  studentsBySession: Record<string, Array<{ id: string }>> = {},
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
  const totalStudents = new Set(entries.flatMap((item) => (
    studentsBySession[item.sessionCode]?.map((student) => student.id) ?? item.studentIds
  ))).size;
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

function taskUrl(patch: { planId?: string; batchId?: string; intakeRunId?: string; view?: "intake" | "plan" | "studio" }) {
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
  const [planManagerRefreshKey, setPlanManagerRefreshKey] = useState(0);
  const [runs, setRuns] = useState<Record<string, FeedbackIntakeRunClient>>({});
  const [decisions, setDecisions] = useState<Record<string, FeedbackIntakeDecision[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [scriptLibrary, setScriptLibrary] = useState<FeedbackScriptLibraryResponse>({ library: null, recommendedLessonNumber: null });
  const [studentsBySession, setStudentsBySession] = useState<Record<string, FeedbackContextStudent[]>>({});
  const [sourceSummaries, setSourceSummaries] = useState<FeedbackGroupIntakeSourceSummary[]>([]);
  const [unassignedSources, setUnassignedSources] = useState<FeedbackGroupIntakeUnassigned[]>([]);
  const [pendingGroupDraft, setPendingGroupDraft] = useState<FeedbackTaskDraftV2 | null>(null);
  const [draftPersistenceReadyScopeKey, setDraftPersistenceReadyScopeKey] = useState("");
  const [loadingGroupRosters, setLoadingGroupRosters] = useState(false);
  const [loadingSingleRoster, setLoadingSingleRoster] = useState(false);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const restoredScopeKey = useRef("");
  const restoredFromStorage = useRef(false);
  const startupGroupRestoreAttemptKey = useRef("");
  const draftRestoreInFlightScopeKey = useRef("");
  const groupEntriesRef = useRef(state.draft.entries);
  const studentsBySessionRef = useRef(studentsBySession);
  const groupDraftModeRef = useRef(state.draft.mode);
  const groupModeSnapshotRef = useRef<FeedbackGroupModeSnapshot | null>(null);
  const rebuildingRestoredSourceSummaries = useRef(false);
  const loadedGroupRosterKey = useRef("");
  const loadedSingleRosterKey = useRef("");
  const materialContextKey = useRef("");
  const operationScopeTokenRef = useRef("");
  const documentSaveHandlerRef = useRef<(() => Promise<boolean>) | null>(null);
  const switchSessionRef = useRef(context.switchSession);
  useLayoutEffect(() => { switchSessionRef.current = context.switchSession; }, [context.switchSession]);
  const setDocumentSaveHandler = useCallback((handler: (() => Promise<boolean>) | null) => {
    documentSaveHandlerRef.current = handler;
  }, []);
  const refreshPlanManager = useCallback(() => {
    setPlanManagerRefreshKey((current) => current + 1);
  }, []);
  const resolveLoadedDocument = useCallback((target: FeedbackStudioPlanTarget & { batchId: string }) => {
    const view = new URLSearchParams(window.location.search).get("view");
    const stage = feedbackTaskStageForView(view, true);
    dispatch({ type: "task", planId: target.id, batchId: target.batchId, stage });
    taskUrl({ planId: target.id, batchId: target.batchId, view: feedbackTaskViewForStage(stage) });
    if (target.sessionCode) switchSessionRef.current(target);
  }, []);
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
  const plannedSessionCodes = useMemo(
    () => new Set(state.draft.plannedSessionCodes),
    [state.draft.plannedSessionCodes],
  );
  const operationScopeToken = feedbackTaskOperationScopeToken(
    context.context.semesterId,
    state.draft,
    plannedSessionCodes,
    { stage: state.stage, planId: state.planId, batchId: state.batchId },
  );
  useLayoutEffect(() => {
    operationScopeTokenRef.current = operationScopeToken;
  }, [operationScopeToken]);
  const updateTaskEntry = useCallback((sessionCode: string, patch: Partial<FeedbackTaskClassDraft>) => {
    groupEntriesRef.current = groupEntriesRef.current.map((item) => (
      item.sessionCode === sessionCode ? { ...item, ...patch } : item
    ));
    dispatch({ type: "entry", sessionCode, patch });
  }, []);
  function operationScopeIsCurrent(startedScopeToken: string) {
    return operationScopeTokenRef.current === startedScopeToken;
  }
  const confirmedGroupRevisionId = context.data?.groupProgress?.lesson?.revisions?.[0]?.id ?? "";
  const confirmedSessionMaterialAt = context.data?.sessionCommonMaterial?.confirmedAt ?? "";
  const draftScriptLessonNumber = context.data?.groupProgress?.lesson?.draftMaterial.semesterScriptSource?.lessonNumber ?? null;
  const draftScope = useMemo<FeedbackTaskDraftScope>(() => ({
    semesterId: context.context.semesterId,
    classId: state.draft.mode === "single" ? entry?.classId ?? context.context.classId ?? "" : context.context.classId ?? "",
    sessionCode: state.draft.mode === "single" ? entry?.sessionCode ?? context.context.sessionCode : context.context.sessionCode,
    ...(state.draft.mode === "group" && state.draft.groupLessonId ? { groupLessonId: state.draft.groupLessonId } : {}),
  }), [context.context.classId, context.context.semesterId, context.context.sessionCode, entry?.classId, entry?.sessionCode, state.draft.groupLessonId, state.draft.mode]);
  const currentDraftScopeKey = draftScope.semesterId && (draftScope.groupLessonId || (draftScope.classId && draftScope.sessionCode))
    ? feedbackTaskDraftScopeKey(draftScope)
    : "";

  useFeedbackTaskDraftPersistence(
    state.draft,
    context.hydrated
      && contextCurrent
      && taskScopeCurrent
      && draftPersistenceReadyScopeKey === currentDraftScopeKey
      && !state.planId
      && !state.batchId
      && state.stage !== "studio",
    draftScope,
  );

  useEffect(() => {
    groupEntriesRef.current = state.draft.entries;
    groupDraftModeRef.current = state.draft.mode;
  }, [state.draft.entries, state.draft.mode]);

  useEffect(() => {
    studentsBySessionRef.current = studentsBySession;
  }, [studentsBySession]);

  useEffect(() => {
    if (state.draft.mode !== "group" || !state.draft.groupLessonId) return;
    groupModeSnapshotRef.current = {
      groupLessonId: state.draft.groupLessonId,
      activeSessionCode: state.draft.activeSessionCode,
      entries: state.draft.entries,
      plannedSessionCodes: [...plannedSessionCodes],
      sourceSummaries,
      unassignedSources,
      unassignedSourceCount: state.draft.unassignedSourceCount,
    };
  }, [plannedSessionCodes, sourceSummaries, state.draft.activeSessionCode, state.draft.entries, state.draft.groupLessonId, state.draft.mode, state.draft.unassignedSourceCount, unassignedSources]);

  useEffect(() => {
    if (!context.hydrated) return;
    const syncFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const planId = params.get("planId") ?? "";
      const batchId = params.get("batchId") ?? "";
      const rawView = params.get("view");
      const stage = feedbackTaskStageForView(rawView, Boolean(planId || batchId));
      if (rawView !== "intake" && rawView !== "plan" && rawView !== "studio") {
        taskUrl({ view: feedbackTaskViewForStage(stage) });
      }
      if (state.planId !== planId || state.batchId !== batchId) dispatch({ type: "task", planId, batchId, stage });
      else if (state.stage !== stage) dispatch({ type: "stage", stage });
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [context.hydrated, state.batchId, state.planId, state.stage]);

  useEffect(() => {
    const session = context.data?.session;
    if (state.stage !== "studio" || !contextCurrent || !session) return;
    if (!groupLesson) {
      setPendingGroupDraft(null);
      return;
    }
    const saved = readFeedbackTaskDraft({
      semesterId: context.context.semesterId,
      classId: session.classId,
      sessionCode: session.code,
      groupLessonId: groupLesson.id,
    });
    setPendingGroupDraft(saved?.mode === "group" && saved.entries.some((item) => item.selected) ? saved : null);
  }, [context.context.semesterId, context.data?.session, contextCurrent, groupLesson, state.batchId, state.planId, state.stage]);

  useEffect(() => {
    if (!context.hydrated || !currentDraftScopeKey || restoredScopeKey.current === currentDraftScopeKey || state.planId || state.batchId) return;
    restoredScopeKey.current = currentDraftScopeKey;
    const saved = readFeedbackTaskDraft(draftScope);
    restoredFromStorage.current = Boolean(saved);
    setDraftPersistenceReadyScopeKey(currentDraftScopeKey);
    if (saved) {
      dispatch({ type: "restore", draft: saved });
      setUnassignedSources(saved.mode === "group" ? saved.unassignedSources : []);
    }
  }, [context.hydrated, currentDraftScopeKey, draftScope, state.batchId, state.planId]);

  useEffect(() => {
    const session = context.data?.session;
    if (!contextCurrent || !groupAvailable || !session || !groupLesson || state.planId || state.batchId || state.stage === "studio") return;
    const singleScope: FeedbackTaskDraftScope = {
      semesterId: context.context.semesterId,
      classId: session.classId,
      sessionCode: session.code,
    };
    const groupScopeKey = feedbackTaskDraftScopeKey({ ...singleScope, groupLessonId: groupLesson.id });
    const attemptKey = feedbackTaskGroupRestoreAttemptKey(singleScope, groupLesson.id);
    if (startupGroupRestoreAttemptKey.current === attemptKey) return;
    startupGroupRestoreAttemptKey.current = attemptKey;
    const saved = readFeedbackTaskStartupDraft(singleScope, groupLesson.id);
    if (saved?.source !== "group") return;
    draftRestoreInFlightScopeKey.current = groupScopeKey;
    restoredScopeKey.current = groupScopeKey;
    restoredFromStorage.current = true;
    setDraftPersistenceReadyScopeKey(groupScopeKey);
    dispatch({ type: "restore", draft: saved.draft });
    setUnassignedSources(saved.draft.unassignedSources);
  }, [context.context.semesterId, context.data?.session, contextCurrent, groupAvailable, groupLesson, state.batchId, state.planId, state.stage]);

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
    setSourceSummaries(rebuildGroupSourceSummaries(state.draft.entries.filter((item) => item.selected), runs));
    if (state.draft.entries.every((item) => !item.runId || Boolean(runs[item.runId]))) {
      rebuildingRestoredSourceSummaries.current = false;
    }
  }, [runs, state.draft.entries, state.draft.mode]);

  useEffect(() => {
    if (!context.data?.session || state.stage === "studio") return;
    const session = context.data.session;
    const lesson = context.data.groupProgress?.lesson;
    const members = (context.data.groupProgress?.group.members ?? []).filter((member) => Boolean(member.session));
    if (draftRestoreInFlightScopeKey.current) {
      if (state.draft.mode !== "group" || state.draft.groupLessonId !== lesson?.id) return;
      draftRestoreInFlightScopeKey.current = "";
    }
    if (state.draft.revisionSource?.kind === "batch") {
      const currentMembers = new Map(members.flatMap((member) => member.session
        ? [[member.session.code, member] as const]
        : []));
      const nextEntries = state.draft.entries.map((entry) => {
        const member = currentMembers.get(entry.sessionCode);
        if (!member || member.classId !== entry.classId) return entry;
        const className = member.className ?? member.classCode;
        return entry.classCode === member.classCode && entry.className === className
          ? entry
          : { ...entry, classCode: member.classCode, className };
      });
      if (nextEntries.some((entry, index) => entry !== state.draft.entries[index])) {
        dispatch({ type: "entries", entries: nextEntries });
      }
      return;
    }
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
        studentSelectionInitialized: previous.get(member.session.code)?.studentSelectionInitialized ?? false,
        selected: previous.get(member.session.code)?.selected ?? true,
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
  }, [context.context.className, context.data, state.draft.activeSessionCode, state.draft.entries, state.draft.groupLessonId, state.draft.mode, state.draft.revisionSource, state.stage, studentsBySession]);

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
        setStudentsBySession((current) => ({ ...current, [session.code]: students }));
        const currentEntry = groupEntriesRef.current.find((item) => item.sessionCode === session.code)!;
        const nextEntry = refreshAutomaticFeedbackStudentSelection(
          currentEntry,
          students,
          currentEntry.runId ? runs[currentEntry.runId]?.appliedSummary.assessmentEvidence : {},
        );
        updateTaskEntry(session.code, { studentIds: nextEntry.studentIds });
        loadedSingleRosterKey.current = rosterKey;
      })
      .catch((reason) => {
        if (!cancelled) setError(`ACTIVE 花名册读取失败：${errorMessage(reason)}。请切换课次后重试。`);
      })
      .finally(() => { if (!cancelled) setLoadingSingleRoster(false); });
    return () => { cancelled = true; };
  }, [context.context.semesterId, context.data, runs, state.draft.entries, state.draft.mode, state.stage, updateTaskEntry]);

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
      const latestEntries = groupEntriesRef.current;
      const entryBySession = new Map(latestEntries.map((item) => [item.sessionCode, item]));
      const loaded = results.flatMap((result) => {
        if (result.status !== "fulfilled") return [];
        const target = entryBySession.get(result.value.sessionCode);
        const activeIds = target ? activeIdsByClass.get(target.classId) ?? new Set<string>() : new Set<string>();
        return [{ ...result.value, students: result.value.students.filter((student) => activeIds.has(student.id)) }];
      });
      setStudentsBySession((current) => Object.assign({}, current, ...loaded.map((item) => ({ [item.sessionCode]: item.students }))));
      const studentIds = new Map(loaded.map((item) => [item.sessionCode, item.students.map((student) => student.id)]));
      const nextEntries = mergeLoadedGroupRosterEntries(latestEntries, studentIds);
      if (nextEntries.some((item, index) => item !== latestEntries[index])) dispatch({ type: "entries", entries: nextEntries });
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
    if (state.stage === "studio") return;
    const entries = refreshFeedbackStudentSelections(state.draft.entries, studentsBySession, runs);
    if (entries.some((item, index) => item !== state.draft.entries[index])) {
      dispatch({ type: "entries", entries });
    }
  }, [runs, state.draft.entries, state.stage, studentsBySession]);

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
    if (state.draft.revisionSource) {
      setError("按当前事实修订时会保留来源计划的单班或多班范围；如需另换范围，请新建独立计划。");
      return;
    }
    if (mode === "group") {
      const currentSession = context.data?.session;
      if (!groupAvailable || !groupLesson || !currentSession) return;
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
      const nextDraft: FeedbackTaskDraftV2 = {
        ...state.draft,
        mode: "group",
        groupLessonId: groupLesson.id,
        entries,
        activeSessionCode: entries.some((item) => item.sessionCode === restoredGroup.activeSessionCode)
          ? restoredGroup.activeSessionCode
          : entries.some((item) => item.sessionCode === context.context.sessionCode)
            ? context.context.sessionCode
            : entries[0]?.sessionCode ?? "",
        plannedSessionCodes: restoredGroup.plannedSessionCodes,
        unassignedSourceCount: restoredGroup.unassignedSourceCount,
        unassignedSources: restoredGroup.unassignedSources,
        groupSnapshot: null,
        ...materialPatch,
      };
      const nextScope: FeedbackTaskDraftScope = {
        semesterId: context.context.semesterId,
        classId: currentSession.classId,
        sessionCode: currentSession.code,
        groupLessonId: groupLesson.id,
      };
      writeFeedbackTaskDraft(nextScope, nextDraft);
      const nextScopeKey = feedbackTaskDraftScopeKey(nextScope);
      restoredScopeKey.current = nextScopeKey;
      setDraftPersistenceReadyScopeKey(nextScopeKey);
      dispatch({ type: "restore", draft: nextDraft });
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
        plannedSessionCodes: [...plannedSessionCodes],
        sourceSummaries,
        unassignedSources,
        unassignedSourceCount: state.draft.unassignedSourceCount,
      };
      groupModeSnapshotRef.current = snapshot;
      groupSnapshot = {
        groupLessonId: snapshot.groupLessonId,
        activeSessionCode: snapshot.activeSessionCode,
        entries: snapshot.entries,
        plannedSessionCodes: snapshot.plannedSessionCodes,
        unassignedSourceCount: snapshot.unassignedSourceCount,
        unassignedSources: snapshot.unassignedSources,
      };
      writeFeedbackTaskDraft(draftScope, {
        ...state.draft,
        plannedSessionCodes: snapshot.plannedSessionCodes,
      });
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
    const nextScope: FeedbackTaskDraftScope = {
      semesterId: context.context.semesterId,
      classId: current.classId,
      sessionCode: current.sessionCode,
    };
    const storedSingleDraft = readFeedbackTaskDraft(nextScope);
    const nextDraft: FeedbackTaskDraftV2 = storedSingleDraft?.mode === "single"
      ? { ...storedSingleDraft, plannedSessionCodes: [], groupSnapshot }
      : {
          ...state.draft,
          mode: "single",
          groupLessonId: "",
          entries: [{ ...current, selected: true }],
          activeSessionCode: current.sessionCode,
          plannedSessionCodes: [],
          unassignedSourceCount: 0,
          unassignedSources: [],
          groupSnapshot,
        };
    writeFeedbackTaskDraft(nextScope, nextDraft);
    const nextScopeKey = feedbackTaskDraftScopeKey(nextScope);
    restoredScopeKey.current = nextScopeKey;
    setDraftPersistenceReadyScopeKey(nextScopeKey);
    dispatch({ type: "restore", draft: nextDraft });
    setSourceSummaries([]);
    setUnassignedSources([]);
  }

  function acceptRun(result: { run: FeedbackIntakeRunClient }) {
    setRuns((current) => ({ ...current, [result.run.id]: result.run }));
    setDecisions((current) => ({ ...current, [result.run.id]: Array.isArray(result.run.appliedSummary.decisions) ? result.run.appliedSummary.decisions : [] }));
    updateTaskEntry(result.run.sessionCode, { runId: result.run.id });
    dispatch({ type: "draft", patch: { unassignedSourceCount: 0, unassignedSources: [] } });
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
    const incomingClasses = new Map(result.classes.map((item) => [item.sessionCode, item]));
    const entries = latestEntries.map((current) => {
      const item = incomingClasses.get(current.sessionCode);
      if (!item) return current;
      const old = previous.get(item.sessionCode);
      const rosterWasLoaded = Boolean(studentsBySession[item.sessionCode]);
      const validStudentIds = new Set(item.studentIds);
      return {
        classId: item.classId,
        classCode: item.classCode,
        className: item.className || item.classCode,
        sessionCode: item.sessionCode,
        runId: item.runId,
        studentIds: rosterWasLoaded && old ? old.studentIds.filter((id) => validStudentIds.has(id)) : old?.studentIds ?? item.studentIds,
        studentSelectionInitialized: old?.studentSelectionInitialized ?? false,
        selected: old?.selected ?? true,
      } satisfies FeedbackTaskClassDraft;
    });
    for (const item of result.classes) {
      if (previous.has(item.sessionCode)) continue;
      entries.push({
        classId: item.classId,
        classCode: item.classCode,
        className: item.className || item.classCode,
        sessionCode: item.sessionCode,
        runId: item.runId,
        studentIds: item.studentIds,
        studentSelectionInitialized: false,
        selected: true,
      });
    }
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
    const selectedClassIds = entries
      .filter((item) => item.selected && !plannedSessionCodes.has(item.sessionCode))
      .map((item) => item.classId);
    const currentRoundUnassignedCount = scopeFeedbackGroupUnassignedSources({
      sources: mergedUnassigned,
      selectedClassIds,
      persistedActionableCount: nextActionableCount,
    }).actionableCount;
    groupEntriesRef.current = entries;
    dispatch({
      type: "draft",
      patch: {
        entries,
        activeSessionCode: entries.some((item) => item.sessionCode === state.draft.activeSessionCode) ? state.draft.activeSessionCode : entries[0]?.sessionCode ?? "",
        unassignedSourceCount: nextActionableCount,
        unassignedSources: mergedUnassigned,
      },
    });
    setSourceSummaries(result.sourceSummaries);
    setUnassignedSources(mergedUnassigned);
    taskUrl({ intakeRunId: "" });
    const actionableUnassigned = result.unassigned.filter(isActionableUnassignedSource).length;
    const skippedSourceCount = result.unassigned.length - actionableUnassigned;
    const needsReview = currentRoundUnassignedCount > 0 || result.runs.some((run) => run.issues.some(isBlockingFeedbackIntakeIssue));
    const skipped = skippedSourceCount ? `另有 ${skippedSourceCount} 个不属于当前共同课或无需处理的文件已跳过。` : "";
    setNotice(`${needsReview ? "共同课材料已按各班花名册拆分；进入下一阶段处理阻断异常。" : `共同课材料已一次拆分到 ${result.classes.length} 个班，等待教师确认。`}${skipped}`);
  }

  function ignoreUnassignedSources() {
    const selectedClassIds = groupEntriesRef.current
      .filter((item) => item.selected && !plannedSessionCodes.has(item.sessionCode))
      .map((item) => item.classId);
    const dismissed = dismissFeedbackGroupUnassignedSourcesForSelectedClasses({
      sources: unassignedSources,
      selectedClassIds,
    });
    setUnassignedSources(dismissed.sources);
    dispatch({ type: "draft", patch: {
      unassignedSourceCount: dismissed.persistedActionableCount,
      unassignedSources: dismissed.sources,
    } });
    const preserved = dismissed.persistedActionableCount
      ? `仅属于暂未纳入班级的 ${dismissed.persistedActionableCount} 份材料仍已保留。`
      : "";
    setNotice(`已明确本轮不采用这些未归属材料；如果它们仍在收件箱，下次扫描时还会再次提示。${preserved}`);
  }

  async function uploadFiles(files: File[]) {
    if (!entry || !files.length) return;
    if (contextActionBlocked) {
      setError("课次上下文正在切换，请等当前班级和课次加载完成后再投料。");
      return;
    }
    const groupScope = state.draft.mode === "group" ? feedbackGroupIntakeScope(groupEntriesRef.current, runs, state.draft.plannedSessionCodes) : null;
    if (groupScope && !groupScope.sessionCodes.length) {
      setError("请先重新纳入至少一个班级，再整理共同课材料。");
      return;
    }
    const startedScopeToken = operationScopeTokenRef.current;
    setBusy(true); setError(""); setNotice("正在整理材料…");
    try {
      const form = new FormData();
      form.set("displayNames", JSON.stringify(files.map((file) => file.webkitRelativePath || file.name)));
      for (const file of files) form.append("files", file);
      if (state.draft.mode === "group") {
        form.set("groupLessonId", state.draft.groupLessonId);
        form.set("sessionCodes", JSON.stringify(groupScope!.sessionCodes));
        if (Object.keys(groupScope!.runIds).length) form.set("runIds", JSON.stringify(groupScope!.runIds));
        const response = await fetch("/api/feedback/intake/group-upload", { method: "POST", body: form });
        const payload = await response.json().catch(() => null) as (FeedbackGroupIntakeUploadResponse & { error?: string }) | null;
        if (!response.ok || !payload?.runs || !payload.classes) throw new Error(payload?.error || "导入共同课材料失败");
        if (!operationScopeIsCurrent(startedScopeToken)) {
          setNotice("原范围的共同课材料已经整理；当前页面未被旧结果覆盖，返回原范围即可继续。");
          return;
        }
        acceptGroupIntake(payload);
      } else {
        form.set("sessionCode", entry.sessionCode);
        if (entry.runId && !runs[entry.runId]?.planId) form.set("runId", entry.runId);
        const response = await fetch("/api/feedback/intake/upload", { method: "POST", body: form });
        const payload = await response.json().catch(() => null) as ({ run?: FeedbackIntakeRunClient; error?: string }) | null;
        if (!response.ok || !payload?.run) throw new Error(payload?.error || "导入材料失败");
        if (!operationScopeIsCurrent(startedScopeToken)) {
          setNotice("原班级的材料已经整理；当前页面未被旧结果覆盖，返回原班级即可继续。");
          return;
        }
        acceptRun({ run: payload.run });
      }
    } catch (reason) {
      if (operationScopeIsCurrent(startedScopeToken)) setError(errorMessage(reason));
      else setNotice("原范围的材料操作已结束；当前页面没有被旧结果覆盖，返回原范围可查看或重试。");
    }
    finally { setBusy(false); }
  }

  async function scanInbox(useExistingFacts = false) {
    if (!entry) return;
    if (contextActionBlocked) {
      setError("课次上下文正在切换，请等当前班级和课次加载完成后再扫描。");
      return;
    }
    const groupScope = state.draft.mode === "group" ? feedbackGroupIntakeScope(groupEntriesRef.current, runs, state.draft.plannedSessionCodes) : null;
    if (groupScope && !groupScope.sessionCodes.length) {
      setError("请先重新纳入至少一个班级，再扫描共同课材料。");
      return;
    }
    const startedScopeToken = operationScopeTokenRef.current;
    setBusy(true); setError(""); setNotice(useExistingFacts ? "正在读取已经确认的课堂事实…" : "正在扫描反馈收件箱…");
    try {
      if (state.draft.mode === "group") {
        const result = await requestJson<FeedbackGroupIntakeUploadResponse>("/api/feedback/intake/group-scan", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupLessonId: state.draft.groupLessonId, sessionCodes: groupScope!.sessionCodes, ...(Object.keys(groupScope!.runIds).length ? { runIds: groupScope!.runIds } : {}), ...(useExistingFacts ? { useExistingFacts: true } : {}) }),
        });
        if (!operationScopeIsCurrent(startedScopeToken)) {
          setNotice("原范围的共同课材料已经扫描；当前页面未被旧结果覆盖，返回原范围即可继续。");
          return;
        }
        acceptGroupIntake(result);
      } else {
        const result = await requestJson<{ run: FeedbackIntakeRunClient }>("/api/feedback/intake/scan", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionCode: entry.sessionCode, ...(entry.runId && !runs[entry.runId]?.planId ? { runId: entry.runId } : {}), ...(useExistingFacts ? { useExistingFacts: true } : {}) }),
        });
        if (!operationScopeIsCurrent(startedScopeToken)) {
          setNotice("原班级的材料已经扫描；当前页面未被旧结果覆盖，返回原班级即可继续。");
          return;
        }
        acceptRun(result);
      }
    } catch (reason) {
      if (operationScopeIsCurrent(startedScopeToken)) setError(errorMessage(reason));
      else setNotice("原范围的扫描已结束；当前页面没有被旧结果覆盖，返回原范围可查看或重试。");
    }
    finally { setBusy(false); }
  }

  async function persistSelectedCommonMaterial(startedScopeToken: string): Promise<MaterialSelection | null> {
    if (!commonMaterialChoice.startsWith("library:")) {
      return forcedInheritedMaterial && availableMaterial ? availableMaterial : state.draft.materialSelection;
    }
    const lessonNumber = Number(commonMaterialChoice.slice("library:".length));
    if (!Number.isInteger(lessonNumber) || lessonNumber <= 0) return null;
    if (commonMaterialAction === "unavailable") throw new Error("草稿所选学期材料当前不可用于本课，请改选当前材料或明确不使用。");
    if (commonMaterialAction === "session") {
      if (!context.data?.session) return null;
      await requestJson(`/api/sessions/${encodeURIComponent(context.data.session.id)}/common-material`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonNumber }),
      });
      await context.refresh();
      if (!operationScopeIsCurrent(startedScopeToken)) return null;
      const selection = { mode: "session_snapshot" as const };
      dispatch({ type: "draft", patch: { materialSelection: selection, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
      return selection;
    }
    const lesson = context.data?.groupProgress?.lesson;
    if (!lesson) return null;
    await requestJson(`/api/group-lessons/${encodeURIComponent(lesson.id)}/common-material`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonNumber }),
    });
    const result = await requestJson<{ revision: { id: string; revision: number } }>(`/api/group-lessons/${encodeURIComponent(lesson.id)}/confirm`, { method: "POST" });
    await context.refresh();
    if (!operationScopeIsCurrent(startedScopeToken)) return null;
    const selection = { mode: "linked_revision" as const, revisionId: result.revision.id };
    dispatch({ type: "draft", patch: { materialSelection: selection, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
    return selection;
  }

  function updateDecision(runId: string, decision: FeedbackIntakeDecision) {
    setDecisions((current) => ({ ...current, [runId]: [...(current[runId] ?? []).filter((item) => item.issueId !== decision.issueId), decision] }));
  }

  async function refreshAppliedFeedbackContexts(
    targetEntries: FeedbackTaskClassDraft[],
    updatedRuns: FeedbackIntakeRunClient[],
    startedScopeToken: string,
    semesterId: string,
  ) {
    const uniqueTargets = [...new Map(targetEntries.map((item) => [item.sessionCode, item])).values()];
    if (!uniqueTargets.length) return 0;
    const settled = await Promise.allSettled(uniqueTargets.map(async (item) => {
      const activeStudents = studentsBySessionRef.current[item.sessionCode];
      if (!activeStudents) throw new Error("ACTIVE 花名册尚未加载");
      const query = new URLSearchParams({ semesterId, sessionCode: item.sessionCode });
      const result = await requestJson<FeedbackContextResponse>(`/api/report/feedback-context?${query}`);
      if (result.session?.code !== item.sessionCode || result.session.classId !== item.classId) {
        throw new Error("课次上下文已变化");
      }
      const activeIds = new Set(activeStudents.map((student) => student.id));
      return {
        sessionCode: item.sessionCode,
        students: result.students.filter((student) => activeIds.has(student.id)),
      };
    }));
    if (!operationScopeIsCurrent(startedScopeToken)) return null;
    const refreshed = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (refreshed.length) {
      const mergedStudents = Object.assign({}, studentsBySessionRef.current, ...refreshed.map((item) => ({
        [item.sessionCode]: item.students,
      })));
      studentsBySessionRef.current = mergedStudents;
      setStudentsBySession(mergedStudents);
      const mergedRuns = Object.assign({}, runs, ...updatedRuns.map((run) => ({ [run.id]: run })));
      const latestEntries = groupEntriesRef.current;
      const nextEntries = refreshFeedbackStudentSelections(latestEntries, mergedStudents, mergedRuns);
      if (nextEntries.some((item, index) => item !== latestEntries[index])) {
        groupEntriesRef.current = nextEntries;
        dispatch({ type: "entries", entries: nextEntries });
      }
    }
    return settled.length - refreshed.length;
  }

  async function confirmMaterialsAndContinue() {
    if (contextActionBlocked) {
      setError("课次上下文正在切换，请等当前班级和课次加载完成后再确认材料。");
      return;
    }
    let revisionDisplayName = state.draft.displayName;
    const selectedEntries = state.draft.entries.filter((item) => item.selected && !plannedSessionCodes.has(item.sessionCode));
    const scopedUnassigned = scopeFeedbackGroupUnassignedSources({
      sources: unassignedSources,
      selectedClassIds: selectedEntries.map((item) => item.classId),
      persistedActionableCount: state.draft.unassignedSourceCount,
    });
    const unassignedCount = scopedUnassigned.actionableCount;
    if (state.draft.mode === "group" && unassignedCount) {
      setError(`还有 ${unassignedCount} 份材料未归入班级或学生，请先处理或明确本轮不采用。`);
      return;
    }
    if (!selectedEntries.length || selectedEntries.some((item) => !item.runId || !runs[item.runId])) {
      setError(state.draft.mode === "group" ? "请先完成共同课一次投料，确保每个真实班级都形成材料运行。" : "请先整理本班材料。");
      return;
    }
    const { alreadyAppliedEntries, blockedEntries, confirmableEntries } = partitionFeedbackIntakeConfirmationEntries(selectedEntries, runs, decisions);
    if (state.draft.mode === "single" && blockedEntries.length) {
      setError(`${blockedEntries.map((item) => item.className).join("、")}仍有异常尚未处理，请在材料详情中完成核对。`);
      return;
    }
    if (state.draft.mode === "group" && !confirmableEntries.length && blockedEntries.length) {
      setError(`${blockedEntries.map((item) => item.className).join("、")}仍有异常尚未处理；可以逐班核对，也可以明确设为“暂不纳入本轮”后先规划已准备班级。`);
      return;
    }
    const startedScopeToken = operationScopeTokenRef.current;
    const operationSemesterId = context.context.semesterId;
    setBusy(true); setError(""); setNotice("正在确认课程材料并写入各班课堂事实…");
    try {
      if (forcedInheritedMaterial && availableMaterial) {
        dispatch({ type: "draft", patch: { materialSelection: availableMaterial, materialSelectionInitialized: true, pendingMaterialLessonNumber: null } });
      }
      const confirmedMaterialSelection = await persistSelectedCommonMaterial(startedScopeToken);
      if (!confirmedMaterialSelection) {
        if (!operationScopeIsCurrent(startedScopeToken)) setNotice("原范围的公共材料已经保存；当前页面未被旧结果覆盖。");
        return;
      }
      if (!operationScopeIsCurrent(startedScopeToken)) {
        setNotice("原范围的公共材料已经保存；当前页面未被旧结果覆盖。");
        return;
      }
      const targets = confirmableEntries;
      const settled = await Promise.allSettled(targets.map((item) => requestJson<{ result: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(item.runId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", decisions: decisions[item.runId] ?? [] }),
      })));
      const { completed, failedEntries } = feedbackIntakeConfirmationOutcome(targets, settled);
      if (!operationScopeIsCurrent(startedScopeToken)) {
        setNotice("原范围的课堂事实确认已经结束；当前页面未被旧结果覆盖，返回原范围即可继续。");
        return;
      }
      const confirmedRuns = Object.assign({}, runs, ...completed.map((run) => ({ [run.id]: run })));
      setRuns(confirmedRuns);
      const recommendationRefreshFailures = await refreshAppliedFeedbackContexts(
        [...alreadyAppliedEntries, ...completed.flatMap((run) => {
          const completedEntry = selectedEntries.find((item) => item.runId === run.id);
          return completedEntry ? [completedEntry] : [];
        })],
        completed,
        startedScopeToken,
        operationSemesterId,
      );
      if (recommendationRefreshFailures === null || !operationScopeIsCurrent(startedScopeToken)) {
        setNotice("原范围的课堂事实已经确认；当前页面未被旧结果覆盖，返回原范围即可继续。");
        return;
      }
      const recommendationNotice = recommendationRefreshFailures
        ? ` ${recommendationRefreshFailures} 个班的推荐范围未能刷新，已写入的课堂事实不受影响；可在规划页手动选择，或返回录入后再次确认。`
        : "";
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
        setNotice(`已有 ${alreadyAppliedEntries.length + completed.length} 个班分别写入事实；未完成班级可继续处理和重试，也可明确暂不纳入本轮后先规划已准备班级。${recommendationNotice}`);
        return;
      }
      if (state.draft.revisionSource && !revisionDisplayName.trim()) {
        const chosen = window.prompt("当前材料和事实已经确认。将据此建立另一份计划，原计划和原正文不会修改。请输入新计划名称：", "当前事实修正版")?.trim();
        if (!chosen) {
          setNotice(`材料与课堂事实已确认；尚未建立新计划，原计划和原正文没有被覆盖。${recommendationNotice}`);
          return;
        }
        revisionDisplayName = chosen;
        dispatch({ type: "draft", patch: { displayName: chosen } });
      }
      const planningDraft = {
        ...state.draft,
        displayName: revisionDisplayName,
        entries: groupEntriesRef.current,
        materialSelection: confirmedMaterialSelection,
        materialSelectionInitialized: true,
        pendingMaterialLessonNumber: null,
      } satisfies FeedbackTaskDraftV2;
      setNotice(`${state.draft.mode === "group" ? `共同录入完成：${selectedEntries.length} 个班的事实已经分别写入。` : "材料与课堂事实已确认。"} 正在建立可恢复的计划草稿…${recommendationNotice}`);
      const created = await confirmScopeAndCreate({ draft: planningDraft, runs: confirmedRuns, startedScopeToken });
      if (!created && operationScopeIsCurrent(startedScopeToken)) {
        dispatch({ type: "restore", draft: planningDraft });
        dispatch({ type: "stage", stage: "confirm" });
        taskUrl({ view: "plan" });
      }
    } catch (reason) {
      if (operationScopeIsCurrent(startedScopeToken)) setError(errorMessage(reason));
      else setNotice("原范围的录入确认已结束；当前页面没有被旧结果覆盖，返回原范围可查看或重试。");
    }
    finally { setBusy(false); }
  }

  async function clearScopes() {
    const startedScopeToken = operationScopeTokenRef.current;
    setBusy(true); setError("");
    try {
      const targets = state.draft.entries.filter((item) => item.selected && item.runId);
      const results = await Promise.all(targets.map((item) => requestJson<{ result: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(item.runId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear_scope" }) })));
      if (!operationScopeIsCurrent(startedScopeToken)) {
        setNotice("原范围已经清除；当前页面未被旧结果覆盖。");
        return;
      }
      setRuns((current) => Object.assign({}, current, ...results.map((result) => ({ [result.result.id]: result.result }))));
      dispatch({ type: "stage", stage: "prepare" });
      setNotice("已清除本轮班级范围；已确认课堂事实仍保留。 ");
    } catch (reason) {
      if (operationScopeIsCurrent(startedScopeToken)) setError(errorMessage(reason));
      else setNotice("原范围的清除操作已结束；当前页面没有被旧结果覆盖。");
    }
    finally { setBusy(false); }
  }

  async function createTaskRequest(
    startedScopeToken = operationScopeTokenRef.current,
    operationDraft = state.draft,
  ) {
    const operationSemesterId = context.context.semesterId;
    const planned = new Set(operationDraft.plannedSessionCodes);
    const selectedEntries = operationDraft.entries.filter((item) => item.selected && !planned.has(item.sessionCode) && item.runId);
    const planType = operationDraft.revisionSource?.type ?? "event_micro";
    const studentOverrides = planType === "class_update"
      ? []
      : selectedFeedbackTaskStudentOverrides(operationDraft, selectedEntries);
    let planId = "";
    let batchId = "";
    if (operationDraft.mode === "single") {
      const target = selectedEntries[0];
      if (!target) throw new Error("没有可建立计划的班级范围");
      const created = await requestJson<{ result: { plan?: { id: string }; planId?: string } }>(`/api/feedback/intake/runs/${encodeURIComponent(target.runId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_plan",
          plan: {
            requestKey: operationDraft.requestKey,
            ...(operationDraft.displayName.trim() ? { displayName: operationDraft.displayName.trim() } : {}),
            ...(operationDraft.revisionSource?.kind === "plan" ? { basedOnPlanId: operationDraft.revisionSource.planId } : {}),
            type: planType,
            outputRequirement: operationDraft.outputRequirement,
            generationMode: operationDraft.generationMode,
            ...(target.rangeStartSessionId ? { rangeStartSessionId: target.rangeStartSessionId } : {}),
            ...(target.rangeEndSessionId ? { rangeEndSessionId: target.rangeEndSessionId } : {}),
            ...(planType === "class_update" ? {} : { studentIds: target.studentIds }),
            generationPreferences: operationDraft.preferences,
            studentOverrides,
            commonMaterial: operationDraft.materialSelection,
          },
        }),
      });
      planId = created.result.plan?.id ?? created.result.planId ?? "";
    } else {
      if (operationDraft.materialSelection.mode === "session_snapshot") {
        throw new Error("班级组计划只能使用共同课修订或明确不使用公共材料");
      }
      const created = await requestJson<{ batch: { id: string; plans: Array<{ id: string }> } }>("/api/report/feedback-plan-batches", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestKey: operationDraft.requestKey,
          ...(operationDraft.displayName.trim() ? { displayName: operationDraft.displayName.trim() } : {}),
          ...(operationDraft.revisionSource?.kind === "batch" ? { basedOnBatchId: operationDraft.revisionSource.batchId } : {}),
          semesterId: operationSemesterId,
          type: planType,
          outputRequirement: operationDraft.outputRequirement,
          generationMode: operationDraft.generationMode,
          generationPreferences: operationDraft.preferences,
          groupLessonId: operationDraft.groupLessonId,
          ...(operationDraft.materialSelection.mode === "linked_revision" ? {
            sharedLessonRevisionId: operationDraft.materialSelection.revisionId,
            sharedMaterialConfirmed: true,
          } : {}),
          plans: selectedEntries.map((item) => {
            const override = operationDraft.classOverrides.find((candidate) => candidate.sessionCode === item.sessionCode);
            return {
              classId: item.classId,
              ...(planType === "stage_trend"
                ? {
                    rangeStartSessionId: item.rangeStartSessionId,
                    rangeEndSessionId: item.rangeEndSessionId ?? item.sessionCode,
                  }
                : { sessionId: item.sessionCode }),
              intakeRunId: item.runId,
              ...(planType === "class_update" ? {} : { studentIds: item.studentIds }),
              outputRequirement: override?.outputRequirement?.trim() || operationDraft.outputRequirement,
              generationPreferences: override?.preferences
                ? { ...operationDraft.preferences, ...override.preferences }
                : operationDraft.preferences,
              ...(planType === "class_update" ? {} : {
                studentOverrides: studentOverrides.filter((candidate) => item.studentIds.includes(candidate.studentId)),
              }),
            };
          }),
        }),
      });
      batchId = created.batch.id;
      planId = created.batch.plans[0]?.id ?? "";
    }
    if (!planId) throw new Error("计划草稿建立后没有返回可打开的计划");
    refreshPlanManager();
    const snapshot = operationDraft.mode === "single" ? operationDraft.groupSnapshot : null;
    const storedGroupDraft = snapshot?.entries[0] ? readFeedbackTaskDraft({
      semesterId: operationSemesterId,
      classId: snapshot.entries[0].classId,
      sessionCode: snapshot.entries[0].sessionCode,
      groupLessonId: snapshot.groupLessonId,
    }) : null;
    const knownGroupDraft = feedbackTaskGroupDraftForFollowUp(operationDraft, storedGroupDraft);
    const followUpDraft = knownGroupDraft ? createFeedbackTaskFollowUpDraft(
      knownGroupDraft,
      selectedEntries.map((item) => item.sessionCode),
    ) : null;
    if (knownGroupDraft) {
      const followUpSnapshot: FeedbackTaskGroupSnapshot | null = followUpDraft ? {
        groupLessonId: followUpDraft.groupLessonId,
        activeSessionCode: followUpDraft.activeSessionCode,
        entries: followUpDraft.entries,
        plannedSessionCodes: followUpDraft.plannedSessionCodes,
        unassignedSourceCount: followUpDraft.unassignedSourceCount,
        unassignedSources: followUpDraft.unassignedSources,
      } : null;
      const submittedSingleSession = operationDraft.mode === "single" ? selectedEntries[0]?.sessionCode : "";
      syncFeedbackTaskSingleDraftGroupSnapshots({
        semesterId: operationSemesterId,
        groupLessonId: knownGroupDraft.groupLessonId,
        entries: knownGroupDraft.entries,
        snapshot: followUpSnapshot,
        clearSessionCodes: submittedSingleSession ? [submittedSingleSession] : [],
      });
      const anchor = knownGroupDraft.entries[0]!;
      const groupScope: FeedbackTaskDraftScope = {
        semesterId: operationSemesterId,
        classId: anchor.classId,
        sessionCode: anchor.sessionCode,
        groupLessonId: knownGroupDraft.groupLessonId,
      };
      if (followUpDraft) writeFeedbackTaskDraft(groupScope, followUpDraft);
      else clearFeedbackTaskDraft(groupScope);
    } else {
      clearFeedbackTaskDraft(draftScope);
    }
    if (!operationScopeIsCurrent(startedScopeToken)) {
      setNotice("原范围的反馈计划已经建立；当前页面未被旧结果覆盖，可从“当前反馈计划”打开。");
      return false;
    }
    setPendingGroupDraft(followUpDraft);
    groupModeSnapshotRef.current = null;
    dispatch({ type: "task", planId, batchId, stage: "confirm" });
    taskUrl({ planId, batchId, intakeRunId: "", view: "plan" });
    const pendingNotice = followUpDraft ? ` 另有 ${followUpDraft.entries.filter((item) => item.selected).length} 个班保留在录入中。` : "";
    setNotice(`计划草稿已建立。名称、学生范围和生成设置会自动保存；确认无误后再开始生成。${pendingNotice}`);
    return true;
  }

  async function confirmScopeAndCreate(options: {
    draft?: FeedbackTaskDraftV2;
    runs?: Record<string, FeedbackIntakeRunClient>;
    startedScopeToken?: string;
  } = {}) {
    if (contextActionBlocked) {
      setError("课次上下文正在切换，请等当前班级和课次加载完成后再创建计划。");
      return false;
    }
    const operationDraft = options.draft ?? state.draft;
    const operationRuns = options.runs ?? runs;
    const planned = new Set(operationDraft.plannedSessionCodes);
    const classUpdate = operationDraft.revisionSource?.type === "class_update";
    const selectedEntries = operationDraft.entries
      .filter((item) => item.selected && !planned.has(item.sessionCode) && item.runId)
      .map((item) => classUpdate
        ? { ...item, studentIds: (studentsBySessionRef.current[item.sessionCode] ?? []).map((student) => student.id) }
        : item);
    const emptyClasses = selectedEntries.filter((item) => item.studentIds.length === 0);
    if (!selectedEntries.length || emptyClasses.length) {
      setError(emptyClasses.length
        ? classUpdate
          ? `${emptyClasses.map((item) => item.className).join("、")}尚未读到 ACTIVE 花名册，不能确认班级事实范围。`
          : `${emptyClasses.map((item) => item.className).join("、")}至少需要选择一名学生。`
        : classUpdate ? "请先选择反馈班级。" : "请先选择反馈班级与学生。");
      return false;
    }
    if (selectedEntries.some((item) => operationRuns[item.runId]?.status !== "applied")) {
      setError("录入与课堂事实尚未全部确认，请返回录入步骤。");
      return false;
    }
    const startedScopeToken = options.startedScopeToken ?? operationScopeTokenRef.current;
    setBusy(true); setError(""); setNotice("正在保存有变化的班级范围…");
    try {
      const targets = selectedEntries.filter((item) => !scopeMatchesEntry(item, operationRuns[item.runId]));
      const settled = await Promise.allSettled(targets.map((item) => requestJson<{ result: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(item.runId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm_scope", scope: { classId: item.classId, sessionCode: item.sessionCode, studentIds: item.studentIds } }),
      })));
      const completed = settled.flatMap((result) => result.status === "fulfilled" ? [result.value.result] : []);
      if (!operationScopeIsCurrent(startedScopeToken)) {
        setNotice("原范围的反馈范围已经保存；当前页面未被旧结果覆盖，返回原范围即可继续。");
        return false;
      }
      setRuns((current) => Object.assign({}, current, ...completed.map((run) => ({ [run.id]: run }))));
      const failedEntries = targets.filter((_, index) => settled[index]?.status === "rejected");
      if (failedEntries.length) {
        setError(`${failedEntries.map((item) => item.className).join("、")}的反馈范围保存失败，尚未创建计划；重试只会补未完成部分。`);
        setNotice(`已保存 ${completed.length} 个班的范围。`);
        return false;
      }
      setNotice("范围已保存，正在建立可恢复的计划草稿…");
      return await createTaskRequest(startedScopeToken, operationDraft);
    } catch (reason) {
      if (operationScopeIsCurrent(startedScopeToken)) setError(errorMessage(reason));
      else setNotice("原范围的计划创建已结束；当前页面没有被旧结果覆盖，可从“当前反馈计划”查看结果。");
      return false;
    }
    finally { setBusy(false); }
  }

  function changeStudioPlan(next: FeedbackStudioPlanTarget) {
    dispatch({ type: "task", planId: next.id, batchId: state.batchId });
    taskUrl({ planId: next.id, batchId: state.batchId, view: "studio" });
    context.switchSession(next);
  }

  async function saveOpenDocument() {
    const handler = documentSaveHandlerRef.current;
    if (!handler) return true;
    const saved = await handler();
    if (!saved) setError("当前计划尚未保存；请先修正保存错误或完成命名，再离开计划页。");
    return saved;
  }

  async function showTaskStage(stage: FeedbackTaskState["stage"]) {
    if (stage === "studio" && state.stage !== "studio" && !(await saveOpenDocument())) return;
    dispatch({ type: "stage", stage });
    taskUrl({ view: feedbackTaskViewForStage(stage) });
  }

  function openChangedTask(target: FeedbackStudioPlanTarget & { batchId: string }) {
    dispatch({ type: "task", planId: target.id, batchId: target.batchId, stage: "confirm" });
    taskUrl({ planId: target.id, batchId: target.batchId, intakeRunId: "", view: "plan" });
    if (target.sessionCode) context.switchSession(target);
    setError("");
    setNotice("已另存为一份独立计划；原计划、正文、批准和导出记录均未修改。");
  }

  async function continueIndependentIntake(seed: FeedbackTaskCurrentFactsSeed) {
    if (!(await saveOpenDocument())) return;
    const base = createFeedbackTaskDraft();
    const groupLessonId = seed.mode === "group" ? seed.groupLessonId || groupLesson?.id || "" : "";
    if (seed.mode === "group" && !groupLessonId) {
      setError("这个历史批次没有可恢复的共同课关联，暂时不能按整批继续录入；原计划没有修改。");
      return;
    }
    const latestGroupRevision = context.data?.groupProgress?.status === "linked"
      ? context.data.groupProgress.lesson?.revisions?.[0]?.id
      : "";
    const latestMaterialSelection: MaterialSelection = latestGroupRevision
      ? { mode: "linked_revision", revisionId: latestGroupRevision }
      : context.data?.sessionCommonMaterial?.confirmedAt
        ? { mode: "session_snapshot" }
        : { mode: "none" };
    const draft: FeedbackTaskDraftV2 = {
      ...base,
      ...seed,
      groupLessonId,
      requestKey: crypto.randomUUID(),
      setupStage: "prepare",
      entries: seed.entries.map((item) => ({ ...item, runId: "", selected: true, studentSelectionInitialized: true })),
      plannedSessionCodes: [],
      materialSelection: latestMaterialSelection,
      materialSelectionInitialized: true,
      unassignedSourceCount: 0,
      unassignedSources: [],
      groupSnapshot: null,
    };
    const first = draft.entries.find((item) => item.sessionCode === draft.activeSessionCode) ?? draft.entries[0];
    const scope: FeedbackTaskDraftScope | null = first ? {
      semesterId: context.context.semesterId,
      classId: first.classId,
      sessionCode: first.sessionCode,
      ...(draft.mode === "group" && draft.groupLessonId ? { groupLessonId: draft.groupLessonId } : {}),
    } : null;
    restoredFromStorage.current = true;
    groupModeSnapshotRef.current = null;
    setPendingGroupDraft(null);
    setSourceSummaries([]);
    setUnassignedSources([]);
    setRuns({});
    setDecisions({});
    groupEntriesRef.current = draft.entries;
    if (scope) {
      writeFeedbackTaskDraft(scope, draft);
      const scopeKey = feedbackTaskDraftScopeKey(scope);
      restoredScopeKey.current = scopeKey;
      setDraftPersistenceReadyScopeKey(scopeKey);
    }
    dispatch({ type: "task", planId: "", batchId: "", stage: "prepare" });
    dispatch({ type: "restore", draft });
    taskUrl({ planId: "", batchId: "", intakeRunId: "", view: "intake" });
    setError("");
    setNotice("已开启独立录入，并沿用原计划的班级、学生范围和生成设置。确认新事实后会要求命名另一份计划；原计划和原正文保持不变。");
  }

  async function openFeedbackTask(target: FeedbackTaskOpenTarget) {
    const changingDocument = target.planId !== state.planId || target.batchId !== state.batchId;
    if (state.stage !== "studio" && (changingDocument || target.view === "studio") && !(await saveOpenDocument())) return;
    if (target.planId !== state.planId || target.batchId !== state.batchId) setPendingGroupDraft(null);
    const stage = target.view === "intake" ? "prepare" : target.view === "plan" ? "confirm" : "studio";
    dispatch({ type: "task", planId: target.planId, batchId: target.batchId, stage });
    taskUrl({ planId: target.planId, batchId: target.batchId, intakeRunId: "", view: target.view ?? "studio" });
    context.setContext({
      semesterId: target.semesterId || context.context.semesterId,
      classId: target.classId,
      className: target.className,
      sessionCode: target.sessionCode,
    });
    setError("");
    setNotice(stage === "prepare" ? "已打开计划采用的录入快照。" : stage === "confirm" ? "已打开反馈计划。" : "已打开反馈计划。");
  }

  function releaseArchivedTask(reference: ArchivedFeedbackTaskReference) {
    const released = releaseArchivedFeedbackTaskReferences(runs, state.draft.plannedSessionCodes, reference);
    setRuns(released.runs);
    if (released.plannedSessionCodes.length !== state.draft.plannedSessionCodes.length) {
      dispatch({ type: "draft", patch: { plannedSessionCodes: released.plannedSessionCodes } });
    }
    const archivedCurrentTask = reference.kind === "batch"
      ? state.batchId === reference.id
      : !state.batchId && state.planId === reference.id;
    if (archivedCurrentTask) {
      dispatch({ type: "task", planId: "", batchId: "" });
      dispatch({ type: "stage", stage: "prepare" });
      taskUrl({ planId: "", batchId: "", intakeRunId: "", view: "intake" });
      setNotice("当前计划已归档；原课堂事实和材料范围仍保留，可以直接调整后建立新计划。");
    }
  }

  function resumePendingGroupClasses() {
    if (!pendingGroupDraft) return;
    const active = pendingGroupDraft.entries.find((item) => item.sessionCode === pendingGroupDraft.activeSessionCode)
      ?? pendingGroupDraft.entries.find((item) => item.selected);
    const session = context.data?.session;
    const scope: FeedbackTaskDraftScope = {
      semesterId: context.context.semesterId,
      classId: session?.classId ?? context.context.classId ?? "",
      sessionCode: session?.code ?? context.context.sessionCode,
      groupLessonId: pendingGroupDraft.groupLessonId,
    };
    const scopeKey = feedbackTaskDraftScopeKey(scope);
    restoredScopeKey.current = scopeKey;
    draftRestoreInFlightScopeKey.current = scopeKey;
    restoredFromStorage.current = true;
    setDraftPersistenceReadyScopeKey(scopeKey);
    loadedGroupRosterKey.current = "";
    rebuildingRestoredSourceSummaries.current = true;
    groupModeSnapshotRef.current = null;
    groupEntriesRef.current = pendingGroupDraft.entries;
    dispatch({ type: "task", planId: "", batchId: "" });
    dispatch({ type: "restore", draft: pendingGroupDraft });
    taskUrl({ planId: "", batchId: "", intakeRunId: "", view: "intake" });
    setSourceSummaries([]);
    setUnassignedSources(pendingGroupDraft.unassignedSources);
    setPendingGroupDraft(null);
    setError("");
    setNotice("已回到未完成班级；当前生成计划会继续保留，不会重新处理已进入计划的班级。");
    if (active) context.switchSession(active);
  }

  async function endAndStartNew() {
    const kind = state.batchId ? "feedback-plan-batches" : "feedback-plans";
    const id = state.batchId || state.planId;
    if (!id || !window.confirm(`结束并归档当前计划，再建立一份新计划吗？课堂事实和历史正文会保留。${pendingGroupDraft ? "未完成班级的本地草稿也会清除。" : ""}`)) return;
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
      if (pendingGroupDraft) {
        const anchor = pendingGroupDraft.entries[0]!;
        syncFeedbackTaskSingleDraftGroupSnapshots({
          semesterId: context.context.semesterId,
          groupLessonId: pendingGroupDraft.groupLessonId,
          entries: pendingGroupDraft.entries,
          snapshot: null,
        });
        clearFeedbackTaskDraft({
          semesterId: context.context.semesterId,
          classId: anchor.classId,
          sessionCode: anchor.sessionCode,
          groupLessonId: pendingGroupDraft.groupLessonId,
        });
      }
      setPendingGroupDraft(null);
      groupModeSnapshotRef.current = null;
      restoredFromStorage.current = false;
      dispatch({ type: "task", planId: "", batchId: "" });
      dispatch({ type: "restore", draft: createFeedbackTaskDraft() });
      dispatch({ type: "stage", stage: "prepare" });
      setSourceSummaries([]);
      setUnassignedSources([]);
      taskUrl({ planId: "", batchId: "", view: "intake" });
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

  const selectedEntries = state.draft.entries.filter((item) => item.selected && !plannedSessionCodes.has(item.sessionCode));
  const scopedUnassignedSources = scopeFeedbackGroupUnassignedSources({
    sources: unassignedSources,
    selectedClassIds: selectedEntries.map((item) => item.classId),
    persistedActionableCount: state.draft.unassignedSourceCount,
  });
  const actionableUnassignedSources = scopedUnassignedSources.actionableSources;
  const actionableUnassignedCount = scopedUnassignedSources.actionableCount;
  const allSelectedRunsApplied = selectedEntries.length > 0
    && selectedEntries.every((item) => runs[item.runId]?.status === "applied");
  const unresolvedBlockingCount = selectedEntries.reduce((total, item) => {
    const run = runs[item.runId];
    if (!run || run.status === "applied") return total;
    return total + run.issues.filter(isBlockingFeedbackIntakeIssue).filter((issue) => !selectedFeedbackIntakeDecision(issue, decisions[run.id] ?? [])).length;
  }, 0);
  const visibleGroupSourceSummaries = rebuildGroupSourceSummaries(selectedEntries, runs, studentsBySession);
  const selectedActiveStudentCount = new Set(selectedEntries.flatMap((item) => (
    studentsBySession[item.sessionCode]?.map((student) => student.id) ?? item.studentIds
  ))).size;
  const groupMaterialSummary: GroupMaterialSummary | undefined = state.draft.mode === "group" ? {
    title: "本轮材料",
    scopeLabel: `${selectedEntries.length} 个班 · ${selectedActiveStudentCount} 名学生`,
    issueCount: unresolvedBlockingCount + actionableUnassignedCount,
    issues: actionableUnassignedSources.length
      ? actionableUnassignedSources.map((item) => ({ message: `${item.fileName}：${item.reason}` }))
      : actionableUnassignedCount
        ? [{ message: `上次保存的录入草稿还有 ${actionableUnassignedCount} 份未归属材料；可以重新投料，或明确本轮不采用。` }]
        : [],
    sources: (["assistant_roster", "step_classroom", "assessment_pdf"] as const).map((kind) => {
      const summary = visibleGroupSourceSummaries.find((item) => item.kind === kind);
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
      const status = feedbackGroupMaterialSourceStatus({
        summaryStatus: summary?.status,
        unresolvedIssueCount,
        allSelectedRunsApplied,
      });
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
  const semesterMaterialsHref = `/semesters/${encodeURIComponent(context.context.semesterId)}#semester-common-materials`;
  const hasPlanDocument = Boolean(state.planId || state.batchId);

  return <main className={styles.page}>
    <PageHeader title="课后工作台" description="录入负责核验材料并沉淀课堂事实；每份反馈计划独立保存规划、生成结果与复核进度，三步可随时回看。" actions={<div className={styles.headerActions}><Badge tone="info">{packageMetadata.version}</Badge><Link className="ui-button ui-button--ghost ui-button--md" href="/feedback/tools">高级工具</Link></div>} />
    <FeedbackPlanManager semesterId={context.context.semesterId} currentPlanId={state.planId} currentBatchId={state.batchId} refreshKey={planManagerRefreshKey} onOpen={(target) => void openFeedbackTask(target)} onArchived={releaseArchivedTask} />
    {(error || context.error) && <StatusBanner tone="danger">{error || context.error}</StatusBanner>}{notice && <StatusBanner tone="info">{notice}</StatusBanner>}
    <section className={styles.taskCard}>
      {state.stage === "prepare" && !hasPlanDocument && <div className="feedback-context-section"><SemesterPicker semesterId={context.context.semesterId} onSemesterChange={context.setSemesterId} classId={context.context.classId} className={context.context.className} onClassChange={context.setClass} sessionCode={context.context.sessionCode} onSessionChange={context.setSessionCode} refreshKey={context.refreshKey} disabled={busy || Boolean(state.draft.revisionSource)} /><div className="feedback-new-session"><Button variant="secondary" onClick={() => setSessionDialogOpen(true)} disabled={busy || Boolean(state.draft.revisionSource) || !context.context.semesterId || !context.context.classId}>新建真实课次</Button></div></div>}
      {state.stage === "prepare" && !hasPlanDocument && groupAvailable && groupLesson && group && <section className={styles.groupScope}><header><div><strong>{state.draft.mode === "group" ? "共同课多班计划" : "当前本班计划"}</strong><span>{group.name} · 第 {groupLesson.sequence} 讲 · {realGroupMembers.length} 个真实班级</span></div><Button variant={state.draft.mode === "group" ? "ghost" : "secondary"} disabled={busy || contextActionBlocked || Boolean(state.draft.revisionSource)} onClick={() => setTaskMode(state.draft.mode === "group" ? "single" : "group")}>{state.draft.mode === "group" ? "返回本班计划" : "处理同讲次多个班"}</Button></header><p>{state.draft.mode === "group" ? "一次投料后按班核对。已准备班级可以先一起规划；未完成班级会保留，需由你明确暂不纳入，之后仍可重新纳入并重试。" : "默认只处理当前班级。需要同讲次多个班一起录入、规划和生成时，再切换到共同课计划。"}</p>{state.draft.mode === "group" && <div className={styles.groupClasses}>{state.draft.entries.map((item) => {
        const alreadyPlanned = plannedSessionCodes.has(item.sessionCode);
        const run = item.runId ? runs[item.runId] : undefined;
        const blocking = run?.status === "applied" ? 0 : run?.issues.filter((issue) => isBlockingFeedbackIntakeIssue(issue) && !selectedFeedbackIntakeDecision(issue, decisions[run.id] ?? [])).length ?? 0;
        const label = alreadyPlanned ? "已进入生成" : loadingGroupRosters && !studentsBySession[item.sessionCode] ? "读取花名册" : run?.status === "applied" ? "事实已写入" : run ? blocking ? `${blocking} 项待核对` : "可以确认" : "等待共同投料";
        return <article key={item.sessionCode} className={item.sessionCode === entry?.sessionCode ? styles.groupClassActive : ""}><div><strong>{item.className}</strong><small>{item.sessionCode} · {studentsBySession[item.sessionCode]?.length ?? item.studentIds.length} 人 · {alreadyPlanned ? "已进入生成" : item.selected ? "已纳入本轮" : "本轮暂不处理"}</small></div><div><Badge tone={alreadyPlanned || run?.status === "applied" ? "success" : "warning"}>{label}</Badge><Button uiSize="sm" variant="ghost" disabled={busy || loadingGroupRosters || alreadyPlanned} aria-pressed={!item.selected} onClick={() => updateTaskEntry(item.sessionCode, { selected: !item.selected })}>{alreadyPlanned ? "已有计划" : item.selected ? "暂不纳入本轮" : "重新纳入本轮"}</Button><Button uiSize="sm" variant="ghost" disabled={busy || loadingGroupRosters} onClick={() => dispatch({ type: "draft", patch: { activeSessionCode: item.sessionCode } })}>设为当前班</Button></div></article>;
      })}</div>}</section>}
      <nav className={styles.taskRail} aria-label="反馈计划阶段"><button type="button" className={state.stage === "prepare" ? styles.activeRail : ""} disabled={busy} onClick={() => void showTaskStage("prepare")}><span>1</span><strong>录入</strong><small>{hasPlanDocument ? "查看采用的材料与事实" : state.draft.mode === "group" ? "共同投料、逐班核验" : "材料可选、事实确认"}</small></button><button type="button" className={state.stage === "confirm" ? styles.activeRail : ""} disabled={busy || (!hasPlanDocument && (!allSelectedRunsApplied || contextActionBlocked))} onClick={() => void showTaskStage("confirm")}><span>2</span><strong>规划</strong><small>{hasPlanDocument ? "查看或修正计划" : state.draft.mode === "group" ? "多班范围与例外" : "学生范围与反馈要求"}</small></button><button type="button" className={state.stage === "studio" ? styles.activeRail : ""} disabled={busy || !hasPlanDocument} onClick={() => void showTaskStage("studio")}><span>3</span><strong>生成</strong><small>{state.draft.mode === "group" || state.batchId ? "按班进度与局部重试" : "生成、复核与批准"}</small></button></nav>
      {hasPlanDocument && state.stage !== "studio" && <FeedbackTaskDocumentStage view={state.stage === "prepare" ? "intake" : "plan"} planId={state.planId} batchId={state.batchId} onPlan={() => void showTaskStage("confirm")} onStudio={() => void showTaskStage("studio")} onSaveHandlerChange={setDocumentSaveHandler} onDocumentResolved={resolveLoadedDocument} onTaskChanged={openChangedTask} onPlanChanged={refreshPlanManager} onContinueIntake={continueIndependentIntake} />}
      {!hasPlanDocument && entry && state.stage === "prepare" && <TaskPreparationStage draft={state.draft} entry={entry} run={currentRun} studentTotal={state.draft.mode === "group" ? selectedEntries.reduce((total, item) => total + (studentsBySession[item.sessionCode]?.length ?? item.studentIds.length), 0) : studentsBySession[entry.sessionCode]?.length ?? entry.studentIds.length} busy={busy || loadingGroupRosters || loadingSingleRoster || contextActionBlocked} confirmDisabled={contextActionBlocked || !selectedEntries.length || selectedEntries.some((item) => !item.runId || !runs[item.runId]) || actionableUnassignedCount > 0 || (state.draft.mode === "single" && unresolvedBlockingCount > 0)} commonMaterialLabel={materialLabel} commonMaterialPreview={selectedMaterialPreview} commonMaterialOptions={commonMaterialOptions} commonMaterialChoice={commonMaterialChoice} commonMaterialAction={commonMaterialAction} commonMaterialHelp={commonMaterialHelp} decisions={currentRun ? decisions[currentRun.id] ?? [] : []} materialSummary={groupMaterialSummary} manualFactsHref={manualFactsHref} semesterMaterialsHref={semesterMaterialsHref} onIgnoreUnassigned={state.draft.mode === "group" && actionableUnassignedCount ? ignoreUnassignedSources : undefined} onDecision={updateDecision} onCommonMaterialChoice={selectCommonMaterial} onFiles={(files) => void uploadFiles(files)} onScan={() => void scanInbox()} onUseExistingFacts={() => void scanInbox(true)} onContinue={() => void confirmMaterialsAndContinue()} />}
      {!hasPlanDocument && entry && state.stage === "confirm" && <TaskConfirmationStage draft={state.draft} plannedSessionCodes={[...plannedSessionCodes]} studentsBySession={studentsBySession} scopeSummary={state.draft.mode === "group" ? `${group?.name ?? "共同课"} · 第 ${groupLesson?.sequence ?? "-"} 讲 · ${selectedEntries.map((item) => item.className).join("、")}` : `${entry.className} · ${entry.sessionCode}`} busy={busy || loadingGroupRosters || loadingSingleRoster || contextActionBlocked} onEntry={updateTaskEntry} onDraft={(patch) => dispatch({ type: "draft", patch })} onClassOverrideChange={(sessionCode, override) => dispatch({ type: "class-override", sessionCode, override })} onStudentOverrideChange={(studentId, generationConfig) => dispatch({ type: "student-override", studentId, generationConfig })} onBack={() => void showTaskStage("prepare")} onStart={() => void confirmScopeAndCreate()} />}
      {!hasPlanDocument && !entry && state.stage !== "studio" && <StatusBanner tone="warning">请先选择真实课次。</StatusBanner>}
      {state.stage === "studio" && <FeedbackTaskStudioStage semesterId={context.context.semesterId} className={context.context.className} sessionCode={context.context.sessionCode} planId={state.planId} batchId={state.batchId} context={context.data} onPlanChange={changeStudioPlan} pendingClassCount={pendingGroupDraft?.entries.filter((item) => item.selected).length ?? 0} onResumePending={pendingGroupDraft ? resumePendingGroupClasses : undefined} onNewTask={() => void endAndStartNew()} />}
    </section>
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
