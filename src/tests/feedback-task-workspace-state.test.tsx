import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { includeIndependentFeedbackStudent, TaskConfirmationStage } from "@/features/feedback/TaskConfirmationStage";
import { TaskPreparationStage } from "@/features/feedback/TaskPreparationStage";
import { syncFeedbackItemDrafts } from "@/features/feedback/FeedbackPlanPanel";
import {
  feedbackStudioInitialPlanTarget,
  feedbackStudioPlanTarget,
  shouldRefreshFeedbackTaskBatch,
} from "@/features/feedback/FeedbackTaskStudioStage";
import { MaterialIntakeCard, MaterialIssueDecision, materialIssueChoices, shouldAcceptMaterialFiles } from "@/features/feedback/MaterialIntakeCard";
import {
  activeFeedbackStudentsForClass,
  createFeedbackTaskFollowUpDraft,
  defaultFeedbackStudentIds,
  feedbackTaskGroupRestoreAttemptKey,
  feedbackGroupIntakeScope,
  feedbackIntakeConfirmationOutcome,
  feedbackTaskGroupDraftForFollowUp,
  feedbackGroupMaterialSourceStatus,
  mergeGroupUnassignedSources,
  mergeLoadedGroupRosterEntries,
  feedbackTaskOperationScopeToken,
  partitionFeedbackIntakeConfirmationEntries,
  rebuildGroupSourceSummaries,
  releaseArchivedFeedbackTaskReferences,
  refreshFeedbackStudentSelections,
  refreshAutomaticFeedbackStudentSelection,
  restoreFeedbackGroupMode,
  selectedFeedbackTaskStudentOverrides,
} from "@/features/feedback/FeedbackTaskWorkspace";
import {
  createFeedbackTaskDraft,
  feedbackTaskReducer,
  feedbackTaskStageForView,
  feedbackTaskViewForStage,
  resolveFeedbackTaskMaterialChoice,
  type FeedbackTaskClassDraft,
  type FeedbackTaskState,
} from "@/features/feedback/feedback-task-state";
import type { FeedbackIntakeRunClient } from "@/features/feedback/feedback-task-types";
import { feedbackClassSelection, isFeedbackTaskContextCurrent } from "@/features/feedback/useFeedbackTaskContext";
import { parseFeedbackTaskDraft } from "@/features/feedback/useFeedbackTaskDraft";

const entries: FeedbackTaskClassDraft[] = [
  { classId: "class-a", classCode: "A", className: "合成一班", sessionCode: "session-a", runId: "run-a", studentIds: ["student-a", "student-b"], studentSelectionInitialized: true, selected: true },
  { classId: "class-b", classCode: "B", className: "合成二班", sessionCode: "session-b", runId: "run-b", studentIds: ["student-c"], studentSelectionInitialized: true, selected: true },
];

function run(entry: FeedbackTaskClassDraft, status: string, issues: FeedbackIntakeRunClient["issues"] = [], scoped = false): FeedbackIntakeRunClient {
  return {
    id: entry.runId,
    sessionCode: entry.sessionCode,
    status,
    sourceManifest: [{ name: `${entry.classCode}-assistant.xlsx`, kind: "assistant_roster" }],
    appliedSummary: {
      appliedStudentCount: entry.studentIds.length,
      assessmentStudentCount: 0,
      ...(scoped ? { scopeConfirmation: { classId: entry.classId, sessionCode: entry.sessionCode, studentIds: entry.studentIds, confirmedAt: "2026-08-25T00:00:00.000Z" } } : {}),
    },
    issues,
    planId: null,
  };
}

function groupDraft() {
  return {
    ...createFeedbackTaskDraft(),
    mode: "group" as const,
    groupLessonId: "lesson-1",
    activeSessionCode: entries[0].sessionCode,
    entries,
  };
}

describe("feedback task group workspace state", () => {
  it("maps persistent intake, plan and studio views without treating studio as available before a plan exists", () => {
    expect(feedbackTaskViewForStage("prepare")).toBe("intake");
    expect(feedbackTaskViewForStage("confirm")).toBe("plan");
    expect(feedbackTaskViewForStage("studio")).toBe("studio");

    expect(feedbackTaskStageForView("intake", true)).toBe("prepare");
    expect(feedbackTaskStageForView("plan", true)).toBe("confirm");
    expect(feedbackTaskStageForView("studio", true)).toBe("studio");
    expect(feedbackTaskStageForView("studio", false)).toBe("prepare");
    expect(feedbackTaskStageForView(null, true)).toBe("studio");
    expect(feedbackTaskStageForView("unknown", false)).toBe("prepare");
  });

  it("persists group drafts and initializes newly added override collections", () => {
    const legacyDraft = Object.fromEntries(
      Object.entries(groupDraft()).filter(([key]) => !["requestKey", "plannedSessionCodes", "classOverrides", "studentOverrides", "materialSelectionInitialized", "pendingMaterialLessonNumber", "unassignedSourceCount"].includes(key)),
    );
    const restored = parseFeedbackTaskDraft(legacyDraft);
    expect(restored).toMatchObject({ mode: "group", groupLessonId: "lesson-1", entries });
    expect(restored?.requestKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(restored?.classOverrides).toEqual([]);
    expect(restored?.studentOverrides).toEqual([]);
    expect(restored?.plannedSessionCodes).toEqual([]);
    expect(restored?.materialSelectionInitialized).toBe(true);
    expect(restored?.pendingMaterialLessonNumber).toBeNull();
    expect(restored?.displayName).toBe("初版计划");
  });

  it("keeps an explicit no-material choice after draft restoration", () => {
    const draft = { ...groupDraft(), materialSelection: { mode: "none" as const }, materialSelectionInitialized: true };
    const restored = parseFeedbackTaskDraft(draft);
    expect(restored?.materialSelection).toEqual({ mode: "none" });
    expect(restored?.materialSelectionInitialized).toBe(true);
    expect(resolveFeedbackTaskMaterialChoice(restored!, { mode: "linked_revision", revisionId: "revision-latest" })).toEqual({ value: "none" });
  });

  it("shows a restored historical revision without previewing the latest material", () => {
    const draft = { ...groupDraft(), materialSelection: { mode: "linked_revision" as const, revisionId: "revision-old" }, materialSelectionInitialized: true };
    const resolved = resolveFeedbackTaskMaterialChoice(draft, { mode: "linked_revision", revisionId: "revision-latest" });
    expect(resolved.value).not.toBe("current");
    const markup = renderToStaticMarkup(<TaskPreparationStage
      draft={draft}
      entry={entries[0]}
      run={null}
      studentTotal={3}
      busy={false}
      commonMaterialLabel="当前共同课已有最新修订"
      commonMaterialPreview=""
      commonMaterialOptions={[
        { value: "none", label: "本次不使用公共材料" },
        { value: "current", label: "使用当前课次已确认公共材料" },
        { value: resolved.value, label: resolved.historicalLabel! },
      ]}
      commonMaterialChoice={resolved.value}
      commonMaterialAction="group"
      commonMaterialHelp="历史修订不会自动替换"
      onFiles={() => undefined}
      onScan={() => undefined}
      onUseExistingFacts={() => undefined}
      onCommonMaterialChoice={() => undefined}
      onContinue={() => undefined}
      manualFactsHref="/feedback/tools?tool=manual"
    />);
    expect(markup).toContain("草稿中保存的历史共同课修订");
    expect(markup).not.toContain("最新材料正文");
  });

  it("keeps the same request key while restoring the same draft", () => {
    const draft = groupDraft();
    expect(parseFeedbackTaskDraft(draft)?.requestKey).toBe(draft.requestKey);
  });

  it("upserts and removes class and student strategy overrides", () => {
    const initial: FeedbackTaskState = { stage: "prepare", draft: groupDraft(), planId: "", batchId: "" };
    const withClass = feedbackTaskReducer(initial, { type: "class-override", sessionCode: "session-b", override: { outputRequirement: "合成二班重点说明课堂方法" } });
    const generationConfig = {
      version: 1 as const,
      type: "event_micro" as const,
      outputRequirement: "只说明合成学生的本课表现",
      generationPreferences: { closureType: "positive_recognition" as const, length: "short" as const, tone: "gentle" as const, moduleKeys: ["observed_moment"] },
    };
    const withStudent = feedbackTaskReducer(withClass, { type: "student-override", studentId: "student-c", generationConfig });
    expect(withStudent.draft.classOverrides).toEqual([{ sessionCode: "session-b", outputRequirement: "合成二班重点说明课堂方法" }]);
    expect(withStudent.draft.studentOverrides).toEqual([{ studentId: "student-c", generationConfig }]);
    expect(feedbackTaskReducer(withStudent, { type: "class-override", sessionCode: "session-b", override: null }).draft.classOverrides).toEqual([]);
    expect(feedbackTaskReducer(withStudent, { type: "student-override", studentId: "student-c", generationConfig: null }).draft.studentOverrides).toEqual([]);
  });

  it("includes a student when the teacher saves an independent setting", () => {
    const entry = { ...entries[1], studentIds: [], studentSelectionInitialized: false };
    const included = includeIndependentFeedbackStudent(entry, "student-c");
    expect(included).toMatchObject({ studentIds: ["student-c"], studentSelectionInitialized: true });

    const generationConfig = {
      version: 1 as const,
      type: "event_micro" as const,
      outputRequirement: "单独说明合成学生的本课表现",
      generationPreferences: { closureType: "positive_recognition" as const, length: "short" as const, tone: "gentle" as const, moduleKeys: ["observed_moment"] },
    };
    const draft = {
      ...groupDraft(),
      entries: [entries[0], included],
      studentOverrides: [{ studentId: "student-c", generationConfig }],
    };
    expect(selectedFeedbackTaskStudentOverrides(draft)).toEqual([{ studentId: "student-c", generationConfig }]);
  });

  it("keeps unfinished classes in a fresh follow-up draft without reopening planned classes", () => {
    const original = {
      ...groupDraft(),
      requestKey: "request-original",
      entries: [entries[0], { ...entries[1], selected: false }],
      classOverrides: [
        { sessionCode: "session-a", outputRequirement: "一班要求" },
        { sessionCode: "session-b", outputRequirement: "二班要求" },
      ],
      studentOverrides: [
        { studentId: "student-a", generationConfig: { version: 1 as const, type: "event_micro" as const, outputRequirement: "一班学生", generationPreferences: { closureType: "positive_recognition" as const, moduleKeys: ["observed_moment"] } } },
        { studentId: "student-c", generationConfig: { version: 1 as const, type: "event_micro" as const, outputRequirement: "二班学生", generationPreferences: { closureType: "positive_recognition" as const, moduleKeys: ["observed_moment"] } } },
      ],
    };
    const followUp = createFeedbackTaskFollowUpDraft(original, ["session-a"]);
    expect(followUp).not.toBeNull();
    expect(followUp?.requestKey).not.toBe(original.requestKey);
    expect(followUp?.setupStage).toBe("prepare");
    expect(followUp?.activeSessionCode).toBe("session-b");
    expect(followUp?.plannedSessionCodes).toEqual(["session-a"]);
    expect(followUp?.entries.map((item) => ({ sessionCode: item.sessionCode, runId: item.runId, selected: item.selected }))).toEqual([
      { sessionCode: "session-a", runId: "run-a", selected: false },
      { sessionCode: "session-b", runId: "run-b", selected: true },
    ]);
    expect(followUp?.classOverrides).toEqual([{ sessionCode: "session-b", outputRequirement: "二班要求" }]);
    expect(followUp?.studentOverrides.map((item) => item.studentId)).toEqual(["student-c"]);
    expect(feedbackGroupIntakeScope(followUp!.entries, {
      "run-a": { planId: "plan-a" },
      "run-b": { planId: null },
    }, followUp!.plannedSessionCodes)).toEqual({ sessionCodes: ["session-b"], runIds: { "session-b": "run-b" } });
    expect(createFeedbackTaskFollowUpDraft(followUp!, ["session-b"])).toBeNull();
  });

  it("releases an archived plan from both the run view and the local planned ledger", () => {
    const released = releaseArchivedFeedbackTaskReferences({
      "run-a": { ...run(entries[0], "applied"), planId: "plan-a" },
      "run-b": { ...run(entries[1], "applied"), planId: "plan-b" },
    }, ["session-a", "session-b"], {
      kind: "plan",
      id: "plan-a",
      planIds: ["plan-a"],
      sessionCodes: ["session-a"],
    });
    expect(released.runs["run-a"]?.planId).toBeNull();
    expect(released.runs["run-b"]?.planId).toBe("plan-b");
    expect(released.plannedSessionCodes).toEqual(["session-b"]);
  });

  it("carries a group snapshot forward when one class creates its task in single mode", () => {
    const singleDraft = {
      ...groupDraft(),
      mode: "single" as const,
      groupLessonId: "",
      activeSessionCode: "session-a",
      entries: [{ ...entries[0], studentIds: ["student-b"] }],
      plannedSessionCodes: [],
      groupSnapshot: {
        groupLessonId: "lesson-1",
        activeSessionCode: "session-a",
        entries,
        plannedSessionCodes: [],
        unassignedSourceCount: 0,
        unassignedSources: [],
      },
    };
    const reconstructed = feedbackTaskGroupDraftForFollowUp(singleDraft);
    expect(reconstructed).toMatchObject({
      mode: "group",
      groupLessonId: "lesson-1",
      entries: [
        { sessionCode: "session-a", studentIds: ["student-b"] },
        { sessionCode: "session-b", runId: "run-b" },
      ],
    });
    const afterA = createFeedbackTaskFollowUpDraft(reconstructed!, ["session-a"]);
    expect(afterA?.plannedSessionCodes).toEqual(["session-a"]);
    expect(afterA?.entries.map((item) => item.selected)).toEqual([false, true]);
    expect(createFeedbackTaskFollowUpDraft(afterA!, ["session-b"])).toBeNull();
  });

  it("rebuilds a single-mode follow-up from stored group settings and preserves unresolved source count", () => {
    const storedGroupDraft = {
      ...groupDraft(),
      outputRequirement: "共同课统一要求",
      generationMode: "fast" as const,
      preferences: { ...groupDraft().preferences, length: "detailed" as const, tone: "professional" as const },
      classOverrides: [{ sessionCode: "session-b", outputRequirement: "二班单独要求" }],
      unassignedSourceCount: 9,
    };
    const singleDraft = {
      ...groupDraft(),
      mode: "single" as const,
      groupLessonId: "",
      activeSessionCode: "session-a",
      entries: [{ ...entries[0], studentIds: ["student-b"] }],
      outputRequirement: "一班当前独立正文",
      plannedSessionCodes: [],
      groupSnapshot: {
        groupLessonId: "lesson-1",
        activeSessionCode: "session-a",
        entries,
        plannedSessionCodes: ["session-a"],
        unassignedSourceCount: 2,
        unassignedSources: [{
          fileName: "二班待归属.pdf",
          kind: "assessment_pdf" as const,
          reason: "仅有二班候选",
          candidateClassIds: ["class-b"],
        }],
      },
    };

    expect(feedbackTaskGroupDraftForFollowUp(singleDraft, storedGroupDraft)).toMatchObject({
      mode: "group",
      groupLessonId: "lesson-1",
      outputRequirement: "共同课统一要求",
      generationMode: "fast",
      preferences: { length: "detailed", tone: "professional" },
      classOverrides: [{ sessionCode: "session-b", outputRequirement: "二班单独要求" }],
      plannedSessionCodes: ["session-a"],
      unassignedSourceCount: 2,
      unassignedSources: [{ fileName: "二班待归属.pdf", candidateClassIds: ["class-b"] }],
      entries: [
        { sessionCode: "session-a", studentIds: ["student-b"] },
        { sessionCode: "session-b", studentIds: ["student-c"] },
      ],
    });
  });

  it("changes the operation scope token when mode, active class or selected group subset changes", () => {
    const draft = groupDraft();
    const groupToken = feedbackTaskOperationScopeToken("semester-a", draft);
    const subsetToken = feedbackTaskOperationScopeToken("semester-a", {
      ...draft,
      entries: [draft.entries[0], { ...draft.entries[1], selected: false }],
    });
    const singleA = {
      ...draft,
      mode: "single" as const,
      groupLessonId: "",
      activeSessionCode: "session-a",
      entries: [entries[0]],
    };
    const singleB = {
      ...singleA,
      activeSessionCode: "session-b",
      entries: [entries[1]],
    };

    expect(subsetToken).not.toBe(groupToken);
    expect(feedbackTaskOperationScopeToken("semester-a", singleA)).not.toBe(groupToken);
    expect(feedbackTaskOperationScopeToken("semester-a", singleB))
      .not.toBe(feedbackTaskOperationScopeToken("semester-a", singleA));
    expect(feedbackTaskOperationScopeToken("semester-a", singleA, [], { stage: "studio", planId: "plan-a", batchId: "" }))
      .not.toBe(feedbackTaskOperationScopeToken("semester-a", singleA, [], { stage: "prepare", planId: "", batchId: "" }));
  });

  it("persists whether the teacher is on materials or students and plans", () => {
    const initial: FeedbackTaskState = { stage: "prepare", draft: groupDraft(), planId: "", batchId: "" };
    const next = feedbackTaskReducer(initial, { type: "stage", stage: "confirm" });
    expect(next.stage).toBe("confirm");
    expect(next.draft.setupStage).toBe("confirm");
    expect(parseFeedbackTaskDraft(next.draft)?.setupStage).toBe("confirm");
  });

  it("shows group default, class exception and student exception on the second page", () => {
    const draft = {
      ...groupDraft(),
      setupStage: "confirm" as const,
      classOverrides: [{ sessionCode: "session-b", outputRequirement: "二班重点说明方法" }],
      studentOverrides: [{
        studentId: "student-c",
        generationConfig: {
          version: 1 as const,
          type: "event_micro" as const,
          outputRequirement: "单独说明",
          generationPreferences: { closureType: "positive_recognition" as const, length: "short" as const, tone: "gentle" as const, moduleKeys: ["observed_moment"] },
        },
      }],
    };
    const markup = renderToStaticMarkup(<TaskConfirmationStage
      draft={draft}
      studentsBySession={{
        "session-a": [{ id: "student-a", name: "甲同学", studentId: "A001", labels: [], preview: { today: [], trend: "", communications: [], labels: [] } }, { id: "student-b", name: "乙同学", studentId: "A002", labels: [], preview: { today: [], trend: "", communications: [], labels: [] } }],
        "session-b": [{ id: "student-c", name: "丙同学", studentId: "B001", labels: [], preview: { today: [], trend: "", communications: [], labels: [] } }],
      }}
      scopeSummary="合成共同课 · 合成一班、合成二班"
      busy={false}
      onEntry={() => undefined}
      onDraft={() => undefined}
      onClassOverrideChange={() => undefined}
      onStudentOverrideChange={() => undefined}
      onBack={() => undefined}
      onStart={() => undefined}
    />);
    expect(markup).toContain("班级组默认反馈计划");
    expect(markup).toContain("合成二班");
    expect(markup).toContain("已调整班级默认");
    expect(markup).toContain("已单独设置");
    expect(markup).toContain("没有推荐时默认全班");
    expect(markup).toContain("教师已调整范围");
    expect(markup).toContain("建立可保存计划");
  });

  it("excludes already planned classes from the confirmation page", () => {
    const markup = renderToStaticMarkup(<TaskConfirmationStage
      draft={{ ...groupDraft(), setupStage: "confirm" }}
      plannedSessionCodes={["session-a"]}
      studentsBySession={{
        "session-a": [{ id: "student-a", name: "甲同学", studentId: "A001", labels: [], preview: { today: [], trend: "", communications: [], labels: [] } }],
        "session-b": [{ id: "student-c", name: "丙同学", studentId: "B001", labels: [], preview: { today: [], trend: "", communications: [], labels: [] } }],
      }}
      scopeSummary="本轮只处理未规划班级"
      busy={false}
      onEntry={() => undefined}
      onDraft={() => undefined}
      onClassOverrideChange={() => undefined}
      onStudentOverrideChange={() => undefined}
      onBack={() => undefined}
      onStart={() => undefined}
    />);
    expect(markup).not.toContain("合成一班");
    expect(markup).toContain("合成二班");
    expect(markup).toContain("1 个班、1 名学生");
  });

  it("keeps exactly three material rows with filenames, counts, text status and source-specific detail buttons", () => {
    const markup = renderToStaticMarkup(<MaterialIntakeCard
      summary={{ title: "本轮材料", scopeLabel: "2 个班", sources: [
        { kind: "assistant_roster", status: "missing", matched: 0, total: 2, unit: "个班", files: [], matchText: "班级 1/2 · 学生 5/6 · 课次待确认" },
        { kind: "step_classroom", status: "ready", matched: 2, total: 2, unit: "个班", files: ["一班.step.txt", "二班.step.txt", "补充.step.txt"] },
        { kind: "assessment_pdf", status: "needs_review", matched: 2, total: 3, unit: "名学生", files: ["测评.zip"], issueCount: 1, issues: [{ message: "一份 PDF 需绑定学生" }] },
      ] }}
      busy={false}
      onFiles={() => undefined}
      onScan={() => undefined}
      onConfirm={() => undefined}
    />);
    expect((markup.match(/<article/g) ?? []).length).toBe(3);
    expect(markup).toContain("尚未上传");
    expect(markup).toContain("一班.step.txt、二班.step.txt，另有 1 个");
    expect(markup).toContain("2/3");
    expect(markup).toContain("班级 1/2 · 学生 5/6 · 课次待确认");
    expect(markup).toContain("未添加");
    expect(markup).toContain("已读取");
    expect(markup).toContain("1 项需核对");
    expect(markup).toContain('aria-label="助教 Excel：查看详情"');
    expect(markup).toContain('aria-label="STEP 报告：查看详情"');
    expect(markup).toContain('aria-label="测评 ZIP / 文件夹：查看详情"');
  });

  it("only offers current-session acceptance for session mismatches", () => {
    expect(materialIssueChoices({ code: "assistant_class_mismatch", message: "班级不一致" }).map((item) => item.action)).toEqual(["ignore_source"]);
    expect(materialIssueChoices({ code: "student_mismatch", message: "学生未匹配" }).map((item) => item.action)).toEqual(["skip_student"]);
    expect(materialIssueChoices({ code: "assistant_date_mismatch", message: "日期不一致" }).map((item) => item.action)).toEqual(["ignore_source", "accept_source"]);
  });

  it("keeps refreshing a completed batch while the teacher reviews students", () => {
    expect(shouldRefreshFeedbackTaskBatch("completed")).toBe(true);
    expect(shouldRefreshFeedbackTaskBatch("paused")).toBe(true);
    expect(shouldRefreshFeedbackTaskBatch("failed")).toBe(true);
    expect(shouldRefreshFeedbackTaskBatch("archived")).toBe(false);
  });

  it("rejects feedback data from a previous class or session while context switches", () => {
    const data = {
      session: {
        id: "session-id-a",
        code: "session-a",
        date: "2026-08-31",
        semesterId: "semester-a",
        semesterNumber: 1,
        classId: "class-a",
      },
      className: "同名班",
      total: 0,
      students: [],
    };
    expect(isFeedbackTaskContextCurrent(data, {
      semesterId: "semester-a",
      classId: "class-a",
      sessionCode: "session-a",
    })).toBe(true);
    expect(isFeedbackTaskContextCurrent(data, {
      semesterId: "semester-a",
      classId: "class-b",
      sessionCode: "session-b",
    })).toBe(false);
    expect(isFeedbackTaskContextCurrent(data, {
      semesterId: "semester-a",
      classId: "",
      sessionCode: "session-a",
    })).toBe(false);
  });

  it("carries the stable class id and session code when Studio switches plans", () => {
    expect(feedbackStudioPlanTarget({
      id: "plan-b",
      status: "completed",
      class: { id: "class-b", code: "B", name: "同名班" },
      session: { code: "session-b" },
      progress: { total: 1, generated: 1, approved: 0, exported: 0, failed: 0 },
      items: [],
    })).toEqual({
      id: "plan-b",
      classId: "class-b",
      className: "同名班",
      sessionCode: "session-b",
    });
  });

  it("resolves the first class plan when a batch Studio deep link omits planId", () => {
    const batch = {
      id: "batch-a",
      status: "completed",
      currentPlanId: null,
      plans: [{
        id: "plan-a",
        status: "completed",
        class: { id: "class-a", code: "A", name: "一班" },
        session: { code: "session-a" },
        progress: { total: 1, generated: 1, approved: 0, exported: 0, failed: 0 },
        items: [],
      }],
    };
    expect(feedbackStudioInitialPlanTarget(batch, "")).toEqual({
      id: "plan-a",
      classId: "class-a",
      className: "一班",
      sessionCode: "session-a",
    });
    expect(feedbackStudioInitialPlanTarget(batch, "existing-plan")).toBeNull();
  });

  it("preserves the selected session when a legacy class name is promoted to its stable id", () => {
    const legacy = { semesterId: "semester-a", className: "同名班", classId: "", sessionCode: "session-a" };
    expect(feedbackClassSelection(legacy, "同名班", "class-a")).toEqual({
      ...legacy,
      classId: "class-a",
    });
    expect(feedbackClassSelection({ ...legacy, classId: "class-a" }, "同名班", "class-b")).toMatchObject({
      classId: "class-b",
      sessionCode: "",
    });
  });

  it("rechecks the startup draft when the active member changes within one group lesson", () => {
    const first = { semesterId: "semester-a", classId: "class-a", sessionCode: "session-a" };
    const second = { semesterId: "semester-a", classId: "class-b", sessionCode: "session-b" };
    expect(feedbackTaskGroupRestoreAttemptKey(first, "lesson-1"))
      .not.toBe(feedbackTaskGroupRestoreAttemptKey(second, "lesson-1"));
  });

  it("keeps historical classroom students out of the current feedback roster", () => {
    const contextStudents = [
      { id: "active-student", name: "在读学生" },
      { id: "historical-student", name: "历史课堂学生" },
    ];
    const activeRoster = [
      { id: "active-student", classId: "class-a" },
      { id: "historical-student", classId: "class-b" },
    ];
    expect(activeFeedbackStudentsForClass(contextStudents, activeRoster, "class-a")).toEqual([
      { id: "active-student", name: "在读学生" },
    ]);
  });

  it("refreshes the automatic recommendation when assessment evidence arrives after the roster", () => {
    const students = [
      { id: "student-a", feedbackRecommendationReasons: [] },
      { id: "student-b", feedbackRecommendationReasons: [] },
    ];
    const automaticEntry = {
      ...entries[0],
      studentIds: [],
      studentSelectionInitialized: false,
    };
    const afterRoster = refreshAutomaticFeedbackStudentSelection(automaticEntry, students);
    expect(afterRoster.studentIds).toEqual(["student-a", "student-b"]);
    expect(afterRoster.studentSelectionInitialized).toBe(false);

    const afterPdf = refreshAutomaticFeedbackStudentSelection(afterRoster, students, {
      "student-b": { source: "assessment_pdf" },
    });
    expect(afterPdf.studentIds).toEqual(["student-b"]);
    expect(afterPdf.studentSelectionInitialized).toBe(false);
  });

  it("keeps a teacher's explicit empty selection and uses all active students when there is no recommendation", () => {
    const students = [
      { id: "student-a", feedbackRecommendationReasons: [] },
      { id: "student-b", feedbackRecommendationReasons: [] },
    ];
    expect(defaultFeedbackStudentIds(students)).toEqual(["student-a", "student-b"]);
    expect(refreshAutomaticFeedbackStudentSelection({
      ...entries[0],
      studentIds: [],
      studentSelectionInitialized: true,
    }, students, { "student-b": { source: "assessment_pdf" } }).studentIds).toEqual([]);
  });

  it("combines context recommendations and assessment evidence in roster order for either workflow mode", () => {
    const students = [
      { id: "student-a", feedbackRecommendationReasons: [] },
      { id: "student-b", feedbackRecommendationReasons: ["本课需要反馈"] },
      { id: "student-c", feedbackRecommendationReasons: [] },
    ];
    expect(defaultFeedbackStudentIds(students, { "student-c": { source: "assessment_pdf" } })).toEqual([
      "student-b",
      "student-c",
    ]);
  });

  it("refreshes only automatic student ranges from post-intake feedback contexts", () => {
    const automatic = { ...entries[0], studentIds: ["student-a"], studentSelectionInitialized: false };
    const manual = { ...entries[1], studentIds: ["student-c"], studentSelectionInitialized: true };
    const refreshed = refreshFeedbackStudentSelections(
      [automatic, manual],
      {
        "session-a": [
          { id: "student-a", feedbackRecommendationReasons: [] },
          { id: "student-b", feedbackRecommendationReasons: ["新写入的课堂事实需要反馈"] },
        ],
        "session-b": [
          { id: "student-c", feedbackRecommendationReasons: [] },
          { id: "student-d", feedbackRecommendationReasons: ["不应覆盖教师选择"] },
        ],
      },
      { "run-a": { appliedSummary: {} }, "run-b": { appliedSummary: {} } },
    );
    expect(refreshed[0].studentIds).toEqual(["student-b"]);
    expect(refreshed[0].studentSelectionInitialized).toBe(false);
    expect(refreshed[1]).toBe(manual);
  });

  it("only applies successfully loaded group rosters and preserves a failed class for retry", () => {
    const latestEntries = [{ ...entries[0], selected: false }, entries[1]];
    const merged = mergeLoadedGroupRosterEntries(latestEntries, new Map([
      ["session-a", ["student-b"]],
    ]));
    expect(merged[0].studentIds).toEqual(["student-b"]);
    expect(merged[0].selected).toBe(false);
    expect(merged[1]).toBe(latestEntries[1]);
    expect(merged[1].studentIds).toEqual(["student-c"]);
  });

  it("separates applied, blocked and confirmable classes without rolling completed classes back", () => {
    const third = {
      ...entries[1],
      classId: "class-c",
      classCode: "C",
      className: "合成三班",
      sessionCode: "session-c",
      runId: "run-c",
    };
    const blockedIssue = {
      id: "issue-b",
      code: "student_mismatch",
      message: "学生尚未匹配",
      severity: "requires_teacher" as const,
    };
    const partition = partitionFeedbackIntakeConfirmationEntries(
      [entries[0], entries[1], third],
      {
        "run-a": run(entries[0], "applied"),
        "run-b": run(entries[1], "inspected", [blockedIssue]),
        "run-c": run(third, "inspected"),
      },
      {},
    );
    expect(partition.alreadyAppliedEntries).toEqual([entries[0]]);
    expect(partition.blockedEntries).toEqual([entries[1]]);
    expect(partition.confirmableEntries).toEqual([third]);
  });

  it("keeps a failed class retryable while retaining successful confirmation results", () => {
    const completedRun = run(entries[0], "applied");
    const outcome = feedbackIntakeConfirmationOutcome(entries, [
      { status: "fulfilled", value: { result: completedRun } },
      { status: "rejected", reason: new Error("合成请求失败") },
    ]);
    expect(outcome.completed).toEqual([completedRun]);
    expect(outcome.failedEntries).toEqual([entries[1]]);
  });

  it("preserves a teacher's explicit per-class inclusion when group mode is rebuilt", () => {
    const prepared = entries.map((item, index) => ({ ...item, selected: index === 0 }));
    const restored = restoreFeedbackGroupMode({
      groupLessonId: "lesson-1",
      members: prepared.map((item) => ({
        classId: item.classId,
        classCode: item.classCode,
        className: item.className,
        session: { code: item.sessionCode },
      })),
      currentEntries: prepared,
      studentsBySession: {},
      snapshot: null,
    });
    expect(restored.entries.map((item) => item.selected)).toEqual([true, false]);
  });

  it("restores all prepared group work after switching to one class and refreshing", () => {
    const sourceSummaries = [{
      kind: "assistant_roster" as const,
      fileCount: 1,
      matchedClasses: 2,
      totalClasses: 2,
      issueCount: 0,
      status: "complete" as const,
    }];
    const unassignedSources = [{
      fileName: "待确认学生.pdf",
      kind: "assessment_pdf" as const,
      reason: "姓名重名，无法自动归属",
    }];
    const persistedSingle = parseFeedbackTaskDraft({
      ...createFeedbackTaskDraft(),
      activeSessionCode: entries[0].sessionCode,
      entries: [entries[0]],
      groupSnapshot: {
        groupLessonId: "lesson-1",
        activeSessionCode: entries[1].sessionCode,
        entries,
        plannedSessionCodes: [],
        unassignedSourceCount: 1,
      },
    });
    expect(persistedSingle?.groupSnapshot?.entries.map((item) => item.runId)).toEqual(["run-a", "run-b"]);

    const restored = restoreFeedbackGroupMode({
      groupLessonId: "lesson-1",
      members: entries.map((item) => ({
        classId: item.classId,
        classCode: item.classCode,
        className: item.className,
        session: { code: item.sessionCode },
      })),
      currentEntries: [entries[0]],
      studentsBySession: {},
      snapshot: {
        ...persistedSingle!.groupSnapshot!,
        sourceSummaries,
        unassignedSources,
      },
    });
    expect(restored.entries.map((item) => item.runId)).toEqual(["run-a", "run-b"]);
    expect(restored.entries[0].studentIds).toEqual(["student-a", "student-b"]);
    expect(restored.activeSessionCode).toBe("session-b");
    expect(restored.sourceSummaries).toEqual(sourceSummaries);
    expect(restored.unassignedSources).toEqual(unassignedSources);
    expect(restored.unassignedSourceCount).toBe(1);
  });

  it("rebuilds basic material summaries from restored group runs", () => {
    const first = {
      ...run(entries[0], "inspected"),
      sourceManifest: [
        { name: "共同助教表.xlsx", kind: "assistant_roster" },
        { name: "一班.step-classroom.txt", kind: "step_classroom" },
        { name: "student-a.pdf", kind: "assessment_pdf" },
      ],
      appliedSummary: { assessmentEvidence: { "student-a": { score: 8 } } },
    };
    const second = {
      ...run(entries[1], "inspected"),
      sourceManifest: [
        { name: "共同助教表.xlsx", kind: "assistant_roster" },
        { name: "二班.step-classroom.txt", kind: "step_classroom" },
      ],
    };
    expect(rebuildGroupSourceSummaries(entries, { "run-a": first, "run-b": second })).toEqual([
      expect.objectContaining({ kind: "assistant_roster", fileCount: 1, matchedClasses: 2, totalClasses: 2, status: "complete" }),
      expect.objectContaining({ kind: "step_classroom", fileCount: 2, matchedClasses: 2, totalClasses: 2, status: "complete" }),
      expect.objectContaining({ kind: "assessment_pdf", fileCount: 1, matchedStudents: 1, totalStudents: 3, status: "partial" }),
    ]);
  });

  it("treats optional partial coverage without blocking issues as ready", () => {
    expect(feedbackGroupMaterialSourceStatus({
      summaryStatus: "partial",
      unresolvedIssueCount: 0,
      allSelectedRunsApplied: false,
    })).toBe("ready");
    const markup = renderToStaticMarkup(<MaterialIntakeCard
      summary={{
        title: "本轮材料",
        sources: [{
          kind: "assessment_pdf",
          status: feedbackGroupMaterialSourceStatus({
            summaryStatus: "partial",
            unresolvedIssueCount: 0,
            allSelectedRunsApplied: false,
          }),
          matched: 1,
          total: 40,
          unit: "名学生",
          fileCount: 1,
          issueCount: 0,
          files: ["合成测评.pdf"],
        }],
      }}
      busy={false}
      onFiles={() => undefined}
      onScan={() => undefined}
      onConfirm={() => undefined}
    />);
    expect(markup).toContain("已读取");
    expect(markup).not.toContain("需核对");
  });

  it("does not accept drop or input files while material intake is busy", () => {
    expect(shouldAcceptMaterialFiles(true, 1)).toBe(false);
    expect(shouldAcceptMaterialFiles(false, 0)).toBe(false);
    expect(shouldAcceptMaterialFiles(false, 2)).toBe(true);
  });

  it("locks material issue decisions and detail entry points while confirmation is busy", () => {
    const decisionMarkup = renderToStaticMarkup(<MaterialIssueDecision
      busy
      issue={{
        id: "student-issue",
        runId: "run-a",
        code: "student_mismatch",
        message: "学生未匹配",
        stage: "student",
        candidates: [{ id: "student-a", name: "甲同学", studentId: "A001" }],
      }}
      onDecision={() => undefined}
    />);
    expect(decisionMarkup).toMatch(/<select[^>]*disabled=""/);
    expect(decisionMarkup).toMatch(/<input[^>]*type="radio"[^>]*disabled=""/);

    const cardMarkup = renderToStaticMarkup(<MaterialIntakeCard
      summary={{
        issueCount: 1,
        issues: [{ id: "unassigned", message: "一份材料未归属" }],
        sources: [{ kind: "assistant_roster", status: "needs_review", issueCount: 1, issues: [{ id: "source-issue", message: "需要核对" }] }],
      }}
      busy
      onFiles={() => undefined}
      onScan={() => undefined}
      onConfirm={() => undefined}
    />);
    expect(cardMarkup).toMatch(/<button[^>]*aria-label="助教 Excel：查看详情"[^>]*disabled=""/);
    expect(cardMarkup).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*disabled=""/);
  });

  it("does not present resolved intake issues as still pending", () => {
    const resolvedIssue = { id: "resolved-date", code: "assistant_roster_date_mismatch", message: "日期不一致", sourceName: "A-assistant.xlsx", severity: "requires_teacher" as const };
    const markup = renderToStaticMarkup(<TaskPreparationStage
      draft={groupDraft()}
      entry={entries[0]}
      run={run(entries[0], "applied", [resolvedIssue])}
      studentTotal={2}
      busy={false}
      commonMaterialLabel="本次不使用公共材料"
      commonMaterialPreview=""
      commonMaterialOptions={[{ value: "none", label: "本次不使用公共材料" }]}
      commonMaterialChoice="none"
      commonMaterialAction="session"
      commonMaterialHelp=""
      onFiles={() => undefined}
      onScan={() => undefined}
      onUseExistingFacts={() => undefined}
      onCommonMaterialChoice={() => undefined}
      onContinue={() => undefined}
      manualFactsHref="/feedback/tools?tool=manual"
    />);
    expect(markup).toContain("已确认");
    expect(markup).not.toContain("1 项待核对");
  });

  it("keeps unresolved material across continue-adding and clears it when the same file is routed", () => {
    const unresolved = { fileName: "同名学生.pdf", kind: "assessment_pdf" as const, reason: "姓名重名，无法自动归属" };
    const continued = mergeGroupUnassignedSources(
      [unresolved],
      [],
      new Set(["二班新增.step-classroom.txt"]),
    );
    expect(continued).toEqual([unresolved]);
    expect(mergeGroupUnassignedSources(continued, [{
      ...unresolved,
      reason: "仅属于本轮未选班级，已跳过",
      blocking: false,
      candidateClassIds: ["class-b"],
    }], new Set())).toEqual([unresolved]);
    expect(mergeGroupUnassignedSources(continued, [], new Set(["同名学生.pdf"]))).toEqual([]);
  });

  it("keeps an unsaved item draft while navigating across plans", () => {
    const editedA = { "item-a": { text: "A 班教师尚未保存的正文", revision: 3 } };
    const afterOpeningB = syncFeedbackItemDrafts(editedA, [{ id: "item-b", text: "B 班服务端正文", revision: 1 }]);
    expect(afterOpeningB["item-a"]?.text).toBe("A 班教师尚未保存的正文");
    const afterReturningA = syncFeedbackItemDrafts(afterOpeningB, [{ id: "item-a", text: "A 班原服务端正文", revision: 3 }]);
    expect(afterReturningA["item-a"]?.text).toBe("A 班教师尚未保存的正文");
    const afterServerRevision = syncFeedbackItemDrafts(afterReturningA, [{ id: "item-a", text: "A 班服务端新修订", revision: 4 }]);
    expect(afterServerRevision["item-a"]).toEqual({ text: "A 班服务端新修订", revision: 4 });
  });
});
