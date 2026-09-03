import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedbackTaskDraft, type FeedbackTaskDraftV2 } from "@/features/feedback/feedback-task-state";
import {
  clearFeedbackTaskDraft,
  feedbackTaskDraftScopeKey,
  readFeedbackTaskDraft,
  readFeedbackTaskStartupDraft,
  syncFeedbackTaskSingleDraftGroupSnapshots,
  writeFeedbackTaskDraft,
  type FeedbackTaskDraftScope,
} from "@/features/feedback/useFeedbackTaskDraft";

const legacyKey = "student-track:feedback-task-draft:v2";

function storageStub(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function singleScope(suffix: string): FeedbackTaskDraftScope {
  return {
    semesterId: `semester-${suffix}`,
    classId: `class-${suffix}`,
    sessionCode: `session-${suffix}`,
  };
}

function singleDraft(scope: FeedbackTaskDraftScope, runId: string): FeedbackTaskDraftV2 {
  return {
    ...createFeedbackTaskDraft(),
    activeSessionCode: scope.sessionCode,
    entries: [{
      classId: scope.classId,
      classCode: scope.classId,
      className: `合成${scope.classId}`,
      sessionCode: scope.sessionCode,
      runId,
      studentIds: [`student-${runId}`],
      studentSelectionInitialized: true,
      selected: true,
    }],
  };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", storageStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("feedback task draft storage scope", () => {
  it("restores an old unnamed draft with the compatible default name and preserves a teacher name", () => {
    const scope = singleScope("named");
    const unnamed = singleDraft(scope, "run-unnamed");
    delete (unnamed as Partial<FeedbackTaskDraftV2>).displayName;
    sessionStorage.setItem(feedbackTaskDraftScopeKey(scope), JSON.stringify(unnamed));
    expect(readFeedbackTaskDraft(scope)?.displayName).toBe("初版计划");

    const named = { ...singleDraft(scope, "run-named"), displayName: "九月共同课反馈" };
    expect(writeFeedbackTaskDraft(scope, named)).toBe(true);
    expect(readFeedbackTaskDraft(scope)?.displayName).toBe("九月共同课反馈");
  });

  it("preserves the source, blank required name, and range of a current-facts revision draft", () => {
    const scope = singleScope("revision");
    const draft: FeedbackTaskDraftV2 = {
      ...singleDraft(scope, ""),
      displayName: "",
      revisionSource: { kind: "plan", planId: "source-plan", type: "stage_trend" },
      entries: [{
        ...singleDraft(scope, "").entries[0],
        rangeStartSessionId: "range-start",
        rangeEndSessionId: "range-end",
      }],
    };

    expect(writeFeedbackTaskDraft(scope, draft)).toBe(true);
    expect(readFeedbackTaskDraft(scope)).toMatchObject({
      displayName: "",
      revisionSource: { kind: "plan", planId: "source-plan", type: "stage_trend" },
      entries: [{ rangeStartSessionId: "range-start", rangeEndSessionId: "range-end" }],
    });
  });

  it("builds distinct single-context keys and a group key stable across active classes", () => {
    const first = singleScope("a");
    const second = { ...first, semesterId: "semester-b" };
    expect(feedbackTaskDraftScopeKey(first)).not.toBe(feedbackTaskDraftScopeKey(second));

    const groupA = { ...first, groupLessonId: "lesson-1" };
    const groupB = { ...singleScope("b"), semesterId: first.semesterId, groupLessonId: "lesson-1" };
    expect(feedbackTaskDraftScopeKey(groupA)).toBe(feedbackTaskDraftScopeKey(groupB));
  });

  it("writes, reads and clears drafts without touching another context", () => {
    const scopeA = singleScope("a");
    const scopeB = singleScope("b");
    const draftA = singleDraft(scopeA, "run-a");
    const draftB = singleDraft(scopeB, "run-b");

    expect(writeFeedbackTaskDraft(scopeA, draftA)).toBe(true);
    expect(writeFeedbackTaskDraft(scopeB, draftB)).toBe(true);
    expect(readFeedbackTaskDraft(scopeA)?.entries[0].runId).toBe("run-a");
    expect(readFeedbackTaskDraft(scopeB)?.entries[0].runId).toBe("run-b");

    clearFeedbackTaskDraft(scopeA);
    expect(readFeedbackTaskDraft(scopeA)).toBeNull();
    expect(readFeedbackTaskDraft(scopeB)?.entries[0].runId).toBe("run-b");
  });

  it("does not persist a draft under a mismatched context", () => {
    const scopeA = singleScope("a");
    const scopeB = singleScope("b");
    expect(writeFeedbackTaskDraft(scopeB, singleDraft(scopeA, "run-a"))).toBe(false);
    expect(sessionStorage.getItem(feedbackTaskDraftScopeKey(scopeB))).toBeNull();
  });

  it("treats legacy student selections as initialized and preserves an explicit false value", () => {
    const scope = singleScope("a");
    const legacyEntry = { ...singleDraft(scope, "run-a").entries[0] };
    delete (legacyEntry as Partial<typeof legacyEntry>).studentSelectionInitialized;
    const legacy = { ...singleDraft(scope, "run-a"), entries: [legacyEntry] };
    expect(writeFeedbackTaskDraft(scope, legacy as FeedbackTaskDraftV2)).toBe(true);
    expect(readFeedbackTaskDraft(scope)?.entries[0].studentSelectionInitialized).toBe(true);

    const uninitialized = singleDraft(scope, "run-b");
    uninitialized.entries[0].studentSelectionInitialized = false;
    expect(writeFeedbackTaskDraft(scope, uninitialized)).toBe(true);
    expect(readFeedbackTaskDraft(scope)?.entries[0].studentSelectionInitialized).toBe(false);
  });

  it("migrates the legacy global draft only when its current entry matches", () => {
    const scopeA = singleScope("a");
    const scopeB = singleScope("b");
    const draftA = singleDraft(scopeA, "run-a");
    sessionStorage.setItem(legacyKey, JSON.stringify(draftA));

    expect(readFeedbackTaskDraft(scopeB)).toBeNull();
    expect(sessionStorage.getItem(legacyKey)).not.toBeNull();

    expect(readFeedbackTaskDraft(scopeA)?.entries[0].runId).toBe("run-a");
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
    expect(sessionStorage.getItem(feedbackTaskDraftScopeKey(scopeA))).not.toBeNull();
  });

  it("keeps group persistence isolated by group lesson", () => {
    const active = singleScope("a");
    const scope = { ...active, groupLessonId: "lesson-1" };
    const draft: FeedbackTaskDraftV2 = {
      ...singleDraft(active, "run-a"),
      mode: "group",
      groupLessonId: "lesson-1",
    };

    expect(writeFeedbackTaskDraft(scope, draft)).toBe(true);
    expect(readFeedbackTaskDraft(scope)?.groupLessonId).toBe("lesson-1");
    expect(readFeedbackTaskDraft({ ...scope, groupLessonId: "lesson-2" })).toBeNull();
  });

  it("preserves classes explicitly excluded from a group draft and its single-mode snapshot", () => {
    const first = singleScope("a");
    const second = singleScope("b");
    const excludedEntry = { ...singleDraft(second, "run-b").entries[0], selected: false };
    const groupScope = { ...first, groupLessonId: "lesson-1" };
    const groupDraft: FeedbackTaskDraftV2 = {
      ...singleDraft(first, "run-a"),
      mode: "group",
      groupLessonId: "lesson-1",
      entries: [singleDraft(first, "run-a").entries[0], excludedEntry],
    };

    expect(writeFeedbackTaskDraft(groupScope, groupDraft)).toBe(true);
    expect(readFeedbackTaskDraft(groupScope)?.entries.map((entry) => entry.selected)).toEqual([true, false]);

    const singleModeDraft: FeedbackTaskDraftV2 = {
      ...singleDraft(first, "run-a"),
      groupSnapshot: {
        groupLessonId: "lesson-1",
        activeSessionCode: first.sessionCode,
        entries: [singleDraft(first, "run-a").entries[0], excludedEntry],
        plannedSessionCodes: [],
        unassignedSourceCount: 0,
        unassignedSources: [],
      },
    };
    expect(writeFeedbackTaskDraft(first, singleModeDraft)).toBe(true);
    expect(readFeedbackTaskDraft(first)?.groupSnapshot?.entries.map((entry) => entry.selected)).toEqual([true, false]);
  });

  it("keeps old group drafts compatible by defaulting a missing class selection to included", () => {
    const first = singleScope("a");
    const second = singleScope("b");
    const legacyEntry = { ...singleDraft(second, "run-b").entries[0] };
    delete (legacyEntry as Partial<typeof legacyEntry>).selected;
    const scope = { ...first, groupLessonId: "lesson-1" };
    const draft = {
      ...singleDraft(first, "run-a"),
      mode: "group",
      groupLessonId: "lesson-1",
      entries: [singleDraft(first, "run-a").entries[0], legacyEntry],
    } as FeedbackTaskDraftV2;

    expect(writeFeedbackTaskDraft(scope, draft)).toBe(true);
    expect(readFeedbackTaskDraft(scope)?.entries.map((entry) => entry.selected)).toEqual([true, true]);
  });

  it("reaches a group-scoped startup draft with runs, exclusions, student choices and overrides", () => {
    const first = singleScope("a");
    const second = singleScope("b");
    const groupScope = { ...first, groupLessonId: "lesson-1" };
    const studentOverride = {
      studentId: "student-chosen",
      generationConfig: {
        version: 1 as const,
        type: "event_micro" as const,
        outputRequirement: "合成学生单独说明",
        generationPreferences: {
          closureType: "positive_recognition" as const,
          length: "short" as const,
          tone: "gentle" as const,
          moduleKeys: ["observed_moment"],
        },
      },
    };
    const draft: FeedbackTaskDraftV2 = {
      ...singleDraft(first, "run-a"),
      mode: "group",
      groupLessonId: "lesson-1",
      entries: [
        { ...singleDraft(first, "run-a").entries[0], studentIds: ["student-chosen"] },
        { ...singleDraft(second, "run-b").entries[0], selected: false },
      ],
      classOverrides: [{ sessionCode: first.sessionCode, outputRequirement: "合成一班重点说明方法" }],
      studentOverrides: [studentOverride],
    };
    expect(writeFeedbackTaskDraft(groupScope, draft)).toBe(true);

    const startup = readFeedbackTaskStartupDraft(first, "lesson-1");
    expect(startup?.source).toBe("group");
    expect(startup?.draft.entries.map((entry) => entry.runId)).toEqual(["run-a", "run-b"]);
    expect(startup?.draft.entries[0].studentIds).toEqual(["student-chosen"]);
    expect(startup?.draft.entries[1].selected).toBe(false);
    expect(startup?.draft.classOverrides).toEqual(draft.classOverrides);
    expect(startup?.draft.studentOverrides).toEqual([studentOverride]);
  });

  it("restores whichever valid single or group scope was saved last", () => {
    const first = singleScope("a");
    const second = singleScope("b");
    const groupScope = { ...first, groupLessonId: "lesson-1" };
    const olderSingle = singleDraft(first, "run-single");
    const latestGroup: FeedbackTaskDraftV2 = {
      ...singleDraft(first, "run-group-a"),
      mode: "group",
      groupLessonId: "lesson-1",
      entries: [
        singleDraft(first, "run-group-a").entries[0],
        { ...singleDraft(second, "run-group-b").entries[0], selected: false },
      ],
    };

    expect(writeFeedbackTaskDraft(first, olderSingle)).toBe(true);
    expect(writeFeedbackTaskDraft(groupScope, latestGroup)).toBe(true);
    expect(sessionStorage.getItem(feedbackTaskDraftScopeKey(first))).not.toBeNull();
    expect(sessionStorage.getItem(feedbackTaskDraftScopeKey(groupScope))).not.toBeNull();

    expect(readFeedbackTaskStartupDraft(first, "lesson-1")).toMatchObject({
      source: "group",
      draft: {
        entries: [
          { runId: "run-group-a", selected: true },
          { runId: "run-group-b", selected: false },
        ],
      },
    });

    const latestSingle: FeedbackTaskDraftV2 = {
      ...singleDraft(first, "run-single"),
      groupSnapshot: {
        groupLessonId: "lesson-1",
        activeSessionCode: first.sessionCode,
        entries: latestGroup.entries,
        plannedSessionCodes: [],
        unassignedSourceCount: 1,
        unassignedSources: [],
      },
    };

    expect(writeFeedbackTaskDraft(first, latestSingle)).toBe(true);
    expect(sessionStorage.getItem(feedbackTaskDraftScopeKey(first))).not.toBeNull();
    expect(sessionStorage.getItem(feedbackTaskDraftScopeKey(groupScope))).not.toBeNull();

    expect(readFeedbackTaskStartupDraft(first, "lesson-1")).toMatchObject({
      source: "single",
      draft: {
        entries: [{ runId: "run-single" }],
        groupSnapshot: {
          unassignedSourceCount: 1,
          entries: [
            { runId: "run-group-a", selected: true },
            { runId: "run-group-b", selected: false },
          ],
        },
      },
    });
  });

  it("tracks the last single or group mode independently for every group member", () => {
    const first = singleScope("a");
    const second = { ...singleScope("b"), semesterId: first.semesterId };
    const groupScope = { ...first, groupLessonId: "lesson-1" };
    const groupDraft: FeedbackTaskDraftV2 = {
      ...singleDraft(first, "run-group-a"),
      mode: "group",
      groupLessonId: "lesson-1",
      entries: [
        singleDraft(first, "run-group-a").entries[0],
        singleDraft(second, "run-group-b").entries[0],
      ],
    };

    expect(writeFeedbackTaskDraft(second, singleDraft(second, "run-single-b"))).toBe(true);
    expect(writeFeedbackTaskDraft(groupScope, groupDraft)).toBe(true);
    expect(readFeedbackTaskStartupDraft(first, "lesson-1")?.source).toBe("group");
    expect(readFeedbackTaskStartupDraft(second, "lesson-1")?.source).toBe("group");

    expect(writeFeedbackTaskDraft(second, singleDraft(second, "run-single-b"))).toBe(true);
    expect(readFeedbackTaskStartupDraft(second, "lesson-1")).toMatchObject({
      source: "single",
      draft: { entries: [{ runId: "run-single-b" }] },
    });
    expect(readFeedbackTaskStartupDraft(first, "lesson-1")?.source).toBe("group");
  });

  it("clears active group pointers for every member without deleting a newer single pointer", () => {
    const first = singleScope("a");
    const second = { ...singleScope("b"), semesterId: first.semesterId };
    const groupScope = { ...first, groupLessonId: "lesson-1" };
    const groupDraft: FeedbackTaskDraftV2 = {
      ...singleDraft(first, "run-group-a"),
      mode: "group",
      groupLessonId: "lesson-1",
      entries: [
        singleDraft(first, "run-group-a").entries[0],
        singleDraft(second, "run-group-b").entries[0],
      ],
    };

    expect(writeFeedbackTaskDraft(first, singleDraft(first, "run-single-a"))).toBe(true);
    expect(writeFeedbackTaskDraft(groupScope, groupDraft)).toBe(true);
    expect(writeFeedbackTaskDraft(second, singleDraft(second, "run-single-b"))).toBe(true);
    clearFeedbackTaskDraft(groupScope);
    sessionStorage.setItem(feedbackTaskDraftScopeKey(groupScope), JSON.stringify(groupDraft));

    expect(readFeedbackTaskStartupDraft(first, "lesson-1")).toMatchObject({
      source: "single",
      draft: { entries: [{ runId: "run-single-a" }] },
    });
    const secondActiveKey = `${legacyKey}:active:${encodeURIComponent(second.semesterId)}:${encodeURIComponent(second.classId)}:${encodeURIComponent(second.sessionCode)}`;
    expect(sessionStorage.getItem(secondActiveKey)).toBe(feedbackTaskDraftScopeKey(second));
    expect(readFeedbackTaskStartupDraft(second, "lesson-1")).toMatchObject({
      source: "single",
      draft: { entries: [{ runId: "run-single-b" }] },
    });
  });

  it("updates and clears matching group snapshots without changing independent single drafts or active pointers", () => {
    const first = singleScope("a");
    const second = { ...singleScope("b"), semesterId: first.semesterId };
    const firstDraft = {
      ...singleDraft(first, "run-single-a"),
      outputRequirement: "保留一班独立正文",
    };
    const secondDraft = {
      ...singleDraft(second, "run-single-b"),
      outputRequirement: "保留二班独立正文",
    };
    const snapshot = {
      groupLessonId: "lesson-1",
      activeSessionCode: second.sessionCode,
      entries: [
        singleDraft(first, "run-group-a").entries[0],
        singleDraft(second, "run-group-b").entries[0],
      ],
      plannedSessionCodes: [first.sessionCode],
      unassignedSourceCount: 2,
      unassignedSources: [{
        fileName: "二班待归属.pdf",
        kind: "assessment_pdf" as const,
        reason: "仅有二班候选",
        candidateClassIds: [second.classId],
      }],
    };

    expect(writeFeedbackTaskDraft(first, firstDraft)).toBe(true);
    expect(writeFeedbackTaskDraft(second, secondDraft)).toBe(true);
    const firstActiveKey = `${legacyKey}:active:${encodeURIComponent(first.semesterId)}:${encodeURIComponent(first.classId)}:${encodeURIComponent(first.sessionCode)}`;
    const secondActiveKey = `${legacyKey}:active:${encodeURIComponent(second.semesterId)}:${encodeURIComponent(second.classId)}:${encodeURIComponent(second.sessionCode)}`;
    const firstPointer = sessionStorage.getItem(firstActiveKey);
    const secondPointer = sessionStorage.getItem(secondActiveKey);

    syncFeedbackTaskSingleDraftGroupSnapshots({
      semesterId: first.semesterId,
      groupLessonId: "lesson-1",
      entries: snapshot.entries,
      snapshot,
    });

    expect(readFeedbackTaskDraft(first)).toMatchObject({
      outputRequirement: "保留一班独立正文",
      entries: [{ runId: "run-single-a" }],
      groupSnapshot: {
        plannedSessionCodes: [first.sessionCode],
        unassignedSourceCount: 2,
        unassignedSources: [{ fileName: "二班待归属.pdf", candidateClassIds: [second.classId] }],
      },
    });
    expect(readFeedbackTaskDraft(second)).toMatchObject({
      outputRequirement: "保留二班独立正文",
      entries: [{ runId: "run-single-b" }],
      groupSnapshot: {
        plannedSessionCodes: [first.sessionCode],
        unassignedSourceCount: 2,
        unassignedSources: [{ fileName: "二班待归属.pdf", candidateClassIds: [second.classId] }],
      },
    });
    expect(sessionStorage.getItem(firstActiveKey)).toBe(firstPointer);
    expect(sessionStorage.getItem(secondActiveKey)).toBe(secondPointer);

    syncFeedbackTaskSingleDraftGroupSnapshots({
      semesterId: first.semesterId,
      groupLessonId: "lesson-1",
      entries: snapshot.entries,
      snapshot: null,
    });

    expect(readFeedbackTaskDraft(first)).toMatchObject({
      outputRequirement: "保留一班独立正文",
      entries: [{ runId: "run-single-a" }],
      groupSnapshot: null,
    });
    expect(readFeedbackTaskDraft(second)).toMatchObject({
      outputRequirement: "保留二班独立正文",
      entries: [{ runId: "run-single-b" }],
      groupSnapshot: null,
    });
    expect(sessionStorage.getItem(firstActiveKey)).toBe(firstPointer);
    expect(sessionStorage.getItem(secondActiveKey)).toBe(secondPointer);
  });

  it("keeps a matching single draft authoritative and rejects a group draft without the current class session", () => {
    const first = singleScope("a");
    const second = singleScope("b");
    const single = singleDraft(first, "single-run");
    const group: FeedbackTaskDraftV2 = {
      ...singleDraft(second, "group-run"),
      mode: "group",
      groupLessonId: "lesson-1",
    };
    sessionStorage.setItem(feedbackTaskDraftScopeKey({ ...first, groupLessonId: "lesson-1" }), JSON.stringify(group));

    expect(readFeedbackTaskStartupDraft(first, "lesson-1")).toBeNull();
    expect(writeFeedbackTaskDraft(first, single)).toBe(true);
    expect(readFeedbackTaskStartupDraft(first, "lesson-1")).toMatchObject({
      source: "single",
      draft: { entries: [{ runId: "single-run" }] },
    });
  });

  it("migrates a legacy group draft when the current context is any member entry", () => {
    const first = singleScope("a");
    const second = singleScope("b");
    const draft: FeedbackTaskDraftV2 = {
      ...singleDraft(second, "run-b"),
      mode: "group",
      groupLessonId: "lesson-1",
      entries: [singleDraft(first, "run-a").entries[0], singleDraft(second, "run-b").entries[0]],
    };
    sessionStorage.setItem(legacyKey, JSON.stringify(draft));

    const restored = readFeedbackTaskStartupDraft(first, "lesson-1");
    expect(restored?.source).toBe("group");
    expect(restored?.draft.entries.map((entry) => entry.runId)).toEqual(["run-a", "run-b"]);
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
  });
});
