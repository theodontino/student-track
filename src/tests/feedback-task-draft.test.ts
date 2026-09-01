import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedbackTaskDraft, type FeedbackTaskDraftV2 } from "@/features/feedback/feedback-task-state";
import {
  clearFeedbackTaskDraft,
  feedbackTaskDraftScopeKey,
  readFeedbackTaskDraft,
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

    const restored = readFeedbackTaskDraft({ ...first, groupLessonId: "lesson-1" });
    expect(restored?.entries.map((entry) => entry.runId)).toEqual(["run-a", "run-b"]);
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
  });
});
