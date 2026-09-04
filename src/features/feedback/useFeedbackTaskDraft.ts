"use client";

import { useEffect } from "react";
import type { FeedbackTaskClassDraft, FeedbackTaskDraftV2, FeedbackTaskGroupSnapshot } from "./feedback-task-state";
import type { FeedbackGroupIntakeUnassigned } from "./feedback-task-types";

const LEGACY_KEY = "student-track:feedback-task-draft:v2";
const ACTIVE_SCOPE_KEY_PREFIX = `${LEGACY_KEY}:active`;

export type FeedbackTaskDraftScope = {
  semesterId: string;
  classId: string;
  sessionCode: string;
  groupLessonId?: string | null;
};

export function feedbackTaskDraftScopeKey(scope: FeedbackTaskDraftScope) {
  const semesterId = encodeURIComponent(scope.semesterId);
  if (scope.groupLessonId) {
    return `${LEGACY_KEY}:group:${semesterId}:${encodeURIComponent(scope.groupLessonId)}`;
  }
  return `${LEGACY_KEY}:single:${semesterId}:${encodeURIComponent(scope.classId)}:${encodeURIComponent(scope.sessionCode)}`;
}

function feedbackTaskDraftActiveScopeKey(scope: FeedbackTaskDraftScope) {
  if (!scope.semesterId || !scope.classId || !scope.sessionCode) return "";
  return `${ACTIVE_SCOPE_KEY_PREFIX}:${encodeURIComponent(scope.semesterId)}:${encodeURIComponent(scope.classId)}:${encodeURIComponent(scope.sessionCode)}`;
}

function parseEntries(value: unknown): FeedbackTaskClassDraft[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): FeedbackTaskClassDraft[] => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Partial<FeedbackTaskClassDraft>;
    if (
      typeof candidate.classId !== "string"
      || typeof candidate.classCode !== "string"
      || typeof candidate.className !== "string"
      || typeof candidate.sessionCode !== "string"
      || typeof candidate.runId !== "string"
      || !Array.isArray(candidate.studentIds)
      || !candidate.studentIds.every((studentId: unknown) => typeof studentId === "string")
    ) return [];
    return [{
      ...candidate,
      classId: candidate.classId,
      classCode: candidate.classCode,
      className: candidate.className,
      sessionCode: candidate.sessionCode,
      ...(typeof candidate.rangeStartSessionId === "string" ? { rangeStartSessionId: candidate.rangeStartSessionId } : {}),
      ...(typeof candidate.rangeEndSessionId === "string" ? { rangeEndSessionId: candidate.rangeEndSessionId } : {}),
      runId: candidate.runId,
      studentIds: candidate.studentIds,
      studentSelectionInitialized: typeof candidate.studentSelectionInitialized === "boolean"
        ? candidate.studentSelectionInitialized
        : true,
      selected: typeof candidate.selected === "boolean" ? candidate.selected : true,
    }];
  });
}

function parseRevisionSource(value: unknown): FeedbackTaskDraftV2["revisionSource"] {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const validTypes = new Set(["class_update", "event_micro", "stage_trend", "course_end"]);
  if (typeof candidate.type !== "string" || !validTypes.has(candidate.type)) return null;
  if (candidate.kind === "plan" && typeof candidate.planId === "string" && candidate.planId) {
    return { kind: "plan", planId: candidate.planId, type: candidate.type as "class_update" | "event_micro" | "stage_trend" | "course_end" };
  }
  if (candidate.kind === "batch" && typeof candidate.batchId === "string" && candidate.batchId && (candidate.type === "event_micro" || candidate.type === "stage_trend")) {
    return { kind: "batch", batchId: candidate.batchId, type: candidate.type };
  }
  return null;
}

function parseUnassignedSources(value: unknown): FeedbackGroupIntakeUnassigned[] {
  if (!Array.isArray(value)) return [];
  const validKinds = new Set(["assistant_roster", "step_classroom", "assessment_pdf", "ignored"]);
  return value.filter((source): source is FeedbackGroupIntakeUnassigned => Boolean(
    source
    && typeof source === "object"
    && typeof source.fileName === "string"
    && typeof source.reason === "string"
    && typeof source.kind === "string"
    && validKinds.has(source.kind),
  ));
}

function parseGroupSnapshot(value: unknown): FeedbackTaskGroupSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<FeedbackTaskGroupSnapshot>;
  const entries = parseEntries(candidate.entries);
  const active = entries.find((entry) => entry.sessionCode === candidate.activeSessionCode) ?? entries[0];
  if (!candidate.groupLessonId || !active) return null;
  return {
    groupLessonId: candidate.groupLessonId,
    activeSessionCode: active.sessionCode,
    entries,
    plannedSessionCodes: Array.isArray(candidate.plannedSessionCodes)
      ? [...new Set(candidate.plannedSessionCodes.filter((sessionCode): sessionCode is string => typeof sessionCode === "string"))]
      : [],
    unassignedSourceCount: typeof candidate.unassignedSourceCount === "number" && candidate.unassignedSourceCount >= 0
      ? candidate.unassignedSourceCount
      : 0,
    unassignedSources: parseUnassignedSources(candidate.unassignedSources),
  };
}

export function parseFeedbackTaskDraft(value: unknown): FeedbackTaskDraftV2 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<FeedbackTaskDraftV2>;
  if (candidate.version !== 2 || !Array.isArray(candidate.entries)) return null;
  const entries = parseEntries(candidate.entries);
  const active = entries.find((entry) => entry.sessionCode === candidate.activeSessionCode) ?? entries[0];
  if (!active) return null;
  const classOverrides = Array.isArray(candidate.classOverrides)
    ? candidate.classOverrides.filter((override) => override && typeof override.sessionCode === "string")
    : [];
  const studentOverrides = Array.isArray(candidate.studentOverrides)
    ? candidate.studentOverrides.filter((override) => override && typeof override.studentId === "string" && override.generationConfig)
    : [];
  const revisionSource = parseRevisionSource(candidate.revisionSource);
  const shared = {
    ...candidate,
    displayName: typeof candidate.displayName === "string" && (candidate.displayName.trim() || revisionSource)
      ? candidate.displayName.slice(0, 120)
      : "初版计划",
    setupStage: candidate.setupStage === "confirm" ? "confirm" as const : "prepare" as const,
    requestKey: typeof candidate.requestKey === "string" && candidate.requestKey.length >= 8
      ? candidate.requestKey
      : crypto.randomUUID(),
    revisionSource,
    plannedSessionCodes: Array.isArray(candidate.plannedSessionCodes)
      ? [...new Set(candidate.plannedSessionCodes.filter((sessionCode): sessionCode is string => typeof sessionCode === "string"))]
      : [],
    classOverrides,
    studentOverrides,
    materialSelectionInitialized: typeof candidate.materialSelectionInitialized === "boolean" ? candidate.materialSelectionInitialized : true,
    pendingMaterialLessonNumber: Number.isInteger(candidate.pendingMaterialLessonNumber) && Number(candidate.pendingMaterialLessonNumber) > 0
      ? Number(candidate.pendingMaterialLessonNumber)
      : null,
    unassignedSourceCount: typeof candidate.unassignedSourceCount === "number" ? candidate.unassignedSourceCount : 0,
    unassignedSources: parseUnassignedSources(candidate.unassignedSources),
    groupSnapshot: parseGroupSnapshot(candidate.groupSnapshot),
  };
  if (candidate.mode !== "group" || !candidate.groupLessonId) {
    return {
      ...shared,
      version: 2,
      mode: "single",
      groupLessonId: "",
      activeSessionCode: active.sessionCode,
      entries: [{ ...active, selected: true }],
    } as FeedbackTaskDraftV2;
  }
  return {
    ...shared,
    version: 2,
    mode: "group",
    groupLessonId: candidate.groupLessonId,
    activeSessionCode: active.sessionCode,
    entries,
    groupSnapshot: null,
  } as FeedbackTaskDraftV2;
}

function activeDraftEntry(draft: FeedbackTaskDraftV2) {
  return draft.entries.find((entry) => entry.sessionCode === draft.activeSessionCode) ?? draft.entries[0] ?? null;
}

function scopeIsReady(scope: FeedbackTaskDraftScope) {
  return Boolean(
    scope.semesterId
    && (scope.groupLessonId || (scope.classId && scope.sessionCode)),
  );
}

function draftMatchesScopedStorage(draft: FeedbackTaskDraftV2, scope: FeedbackTaskDraftScope) {
  if (scope.groupLessonId) {
    return draft.mode === "group"
      && draft.groupLessonId === scope.groupLessonId
      && (!scope.classId || !scope.sessionCode || draft.entries.some((entry) => (
        entry.classId === scope.classId && entry.sessionCode === scope.sessionCode
      )));
  }
  const entry = activeDraftEntry(draft);
  return draft.mode === "single"
    && entry?.classId === scope.classId
    && entry.sessionCode === scope.sessionCode;
}

function legacyDraftMatchesCurrentEntry(draft: FeedbackTaskDraftV2, scope: FeedbackTaskDraftScope) {
  if (!draftMatchesScopedStorage(draft, scope)) return false;
  if (scope.groupLessonId) {
    return draft.entries.some((entry) => entry.classId === scope.classId && entry.sessionCode === scope.sessionCode);
  }
  const entry = activeDraftEntry(draft);
  return entry?.classId === scope.classId && entry.sessionCode === scope.sessionCode;
}

function readStoredDraft(key: string) {
  try {
    return parseFeedbackTaskDraft(JSON.parse(sessionStorage.getItem(key) ?? "null"));
  } catch { return null; }
}

export function readFeedbackTaskDraft(scope?: FeedbackTaskDraftScope | null): FeedbackTaskDraftV2 | null {
  if (!scope || !scopeIsReady(scope)) return null;
  const scopedKey = feedbackTaskDraftScopeKey(scope);
  const scopedDraft = readStoredDraft(scopedKey);
  if (scopedDraft && draftMatchesScopedStorage(scopedDraft, scope)) return scopedDraft;

  const legacyDraft = readStoredDraft(LEGACY_KEY);
  if (!legacyDraft || !legacyDraftMatchesCurrentEntry(legacyDraft, scope)) return null;
  try {
    writeFeedbackTaskDraft(scope, legacyDraft);
    sessionStorage.removeItem(LEGACY_KEY);
  } catch { /* The matching draft is still safe to restore for this tab. */ }
  return legacyDraft;
}

export function readFeedbackTaskStartupDraft(
  singleScope: FeedbackTaskDraftScope,
  groupLessonId?: string | null,
): { source: "single" | "group"; scope: FeedbackTaskDraftScope; draft: FeedbackTaskDraftV2 } | null {
  const normalizedSingleScope = { ...singleScope, groupLessonId: null };
  const groupScope = { ...normalizedSingleScope, groupLessonId };
  const singleScopeKey = feedbackTaskDraftScopeKey(normalizedSingleScope);
  const groupScopeKey = groupLessonId ? feedbackTaskDraftScopeKey(groupScope) : "";
  const activeScopeKey = sessionStorage.getItem(feedbackTaskDraftActiveScopeKey(normalizedSingleScope));
  if (activeScopeKey === singleScopeKey) {
    const singleDraft = readFeedbackTaskDraft(normalizedSingleScope);
    if (singleDraft) return { source: "single", scope: normalizedSingleScope, draft: singleDraft };
  }
  if (activeScopeKey === groupScopeKey) {
    const groupDraft = readFeedbackTaskDraft(groupScope);
    if (groupDraft) return { source: "group", scope: groupScope, draft: groupDraft };
  }

  const singleDraft = readFeedbackTaskDraft(normalizedSingleScope);
  if (singleDraft) return { source: "single", scope: normalizedSingleScope, draft: singleDraft };
  if (!groupLessonId) return null;
  const groupDraft = readFeedbackTaskDraft(groupScope);
  return groupDraft ? { source: "group", scope: groupScope, draft: groupDraft } : null;
}

export function writeFeedbackTaskDraft(
  scope: FeedbackTaskDraftScope,
  draft: FeedbackTaskDraftV2,
  options: { activate?: boolean } = {},
) {
  if (!scopeIsReady(scope) || !draftMatchesScopedStorage(draft, scope)) return false;
  const scopedKey = feedbackTaskDraftScopeKey(scope);
  const previous = readStoredDraft(scopedKey);
  sessionStorage.setItem(scopedKey, JSON.stringify(draft));
  if (previous?.mode === "group") {
    const currentMembers = new Set(draft.mode === "group" ? draft.entries.map((entry) => `${entry.classId}\u0000${entry.sessionCode}`) : []);
    for (const entry of previous.entries) {
      if (currentMembers.has(`${entry.classId}\u0000${entry.sessionCode}`)) continue;
      const activeScopeKey = feedbackTaskDraftActiveScopeKey({ ...scope, classId: entry.classId, sessionCode: entry.sessionCode });
      if (activeScopeKey && sessionStorage.getItem(activeScopeKey) === scopedKey) sessionStorage.removeItem(activeScopeKey);
    }
  }
  if (options.activate !== false) {
    const pointerScopes = draft.mode === "group"
      ? draft.entries.map((entry) => ({ ...scope, classId: entry.classId, sessionCode: entry.sessionCode }))
      : [scope];
    for (const pointerScope of pointerScopes) {
      const activeScopeKey = feedbackTaskDraftActiveScopeKey(pointerScope);
      if (activeScopeKey) sessionStorage.setItem(activeScopeKey, scopedKey);
    }
  }
  return true;
}

export function clearFeedbackTaskDraft(scope?: FeedbackTaskDraftScope | null) {
  if (!scope || !scopeIsReady(scope)) return;
  const scopedKey = feedbackTaskDraftScopeKey(scope);
  const scopedDraft = readStoredDraft(scopedKey);
  sessionStorage.removeItem(scopedKey);
  const pointerScopes = scopedDraft?.mode === "group"
    ? scopedDraft.entries.map((entry) => ({ ...scope, classId: entry.classId, sessionCode: entry.sessionCode }))
    : [scope];
  for (const pointerScope of pointerScopes) {
    const activeScopeKey = feedbackTaskDraftActiveScopeKey(pointerScope);
    if (activeScopeKey && sessionStorage.getItem(activeScopeKey) === scopedKey) sessionStorage.removeItem(activeScopeKey);
  }
  const legacyDraft = readStoredDraft(LEGACY_KEY);
  if (legacyDraft && legacyDraftMatchesCurrentEntry(legacyDraft, scope)) sessionStorage.removeItem(LEGACY_KEY);
}

export function syncFeedbackTaskSingleDraftGroupSnapshots(input: {
  semesterId: string;
  groupLessonId: string;
  entries: Array<Pick<FeedbackTaskClassDraft, "classId" | "sessionCode">>;
  snapshot: FeedbackTaskGroupSnapshot | null;
  clearSessionCodes?: Iterable<string>;
}) {
  const clearSessionCodes = new Set(input.clearSessionCodes ?? []);
  for (const entry of input.entries) {
    const scope: FeedbackTaskDraftScope = {
      semesterId: input.semesterId,
      classId: entry.classId,
      sessionCode: entry.sessionCode,
    };
    if (clearSessionCodes.has(entry.sessionCode)) {
      clearFeedbackTaskDraft(scope);
      continue;
    }
    const key = feedbackTaskDraftScopeKey(scope);
    const singleDraft = readStoredDraft(key);
    if (singleDraft?.mode !== "single") continue;
    if (singleDraft.groupSnapshot && singleDraft.groupSnapshot.groupLessonId !== input.groupLessonId) continue;
    sessionStorage.setItem(key, JSON.stringify({ ...singleDraft, groupSnapshot: input.snapshot }));
  }
}

function pendingGroupDraftMatchesLesson(
  draft: FeedbackTaskDraftV2 | null,
  groupLessonId: string,
): draft is FeedbackTaskDraftV2 {
  return Boolean(
    draft?.mode === "group"
    && groupLessonId
    && draft.groupLessonId === groupLessonId,
  );
}

export function hydrateFeedbackTaskPendingGroupDraft(
  scope: FeedbackTaskDraftScope,
  pendingDraft: FeedbackTaskDraftV2 | null,
) {
  const groupLessonId = scope.groupLessonId ?? "";
  if (pendingGroupDraftMatchesLesson(pendingDraft, groupLessonId)) {
    writeFeedbackTaskDraft(scope, pendingDraft);
    return pendingDraft.entries.some((entry) => entry.selected) ? pendingDraft : null;
  }

  const saved = readFeedbackTaskDraft(scope);
  if (!pendingGroupDraftMatchesLesson(saved, groupLessonId)) return null;
  return saved.entries.some((entry) => entry.selected) ? saved : null;
}

export function useFeedbackTaskDraftPersistence(
  draft: FeedbackTaskDraftV2,
  enabled: boolean,
  scope?: FeedbackTaskDraftScope | null,
) {
  const semesterId = scope?.semesterId ?? "";
  const classId = scope?.classId ?? "";
  const sessionCode = scope?.sessionCode ?? "";
  const groupLessonId = scope?.groupLessonId ?? "";
  useEffect(() => {
    const currentScope: FeedbackTaskDraftScope = { semesterId, classId, sessionCode, groupLessonId };
    if (!enabled || !scopeIsReady(currentScope)) return;
    const save = () => writeFeedbackTaskDraft(currentScope, draft);
    const timer = window.setTimeout(save, 300);
    window.addEventListener("pagehide", save);
    return () => { window.clearTimeout(timer); window.removeEventListener("pagehide", save); };
  }, [classId, draft, enabled, groupLessonId, semesterId, sessionCode]);
}
