import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskConfirmationStage } from "@/features/feedback/TaskConfirmationStage";
import { TaskPreparationStage } from "@/features/feedback/TaskPreparationStage";
import { syncFeedbackItemDrafts } from "@/features/feedback/FeedbackPlanPanel";
import {
  feedbackStudioPlanTarget,
  shouldRefreshFeedbackTaskBatch,
} from "@/features/feedback/FeedbackTaskStudioStage";
import { MaterialIntakeCard, materialIssueChoices, shouldAcceptMaterialFiles } from "@/features/feedback/MaterialIntakeCard";
import {
  activeFeedbackStudentsForClass,
  mergeGroupUnassignedSources,
  mergeLoadedGroupRosterEntries,
  rebuildGroupSourceSummaries,
  restoreFeedbackGroupMode,
} from "@/features/feedback/FeedbackTaskWorkspace";
import {
  createFeedbackTaskDraft,
  feedbackTaskReducer,
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
  it("persists group drafts and initializes newly added override collections", () => {
    const legacyDraft = Object.fromEntries(
      Object.entries(groupDraft()).filter(([key]) => !["requestKey", "classOverrides", "studentOverrides", "materialSelectionInitialized", "pendingMaterialLessonNumber", "unassignedSourceCount"].includes(key)),
    );
    const restored = parseFeedbackTaskDraft(legacyDraft);
    expect(restored).toMatchObject({ mode: "group", groupLessonId: "lesson-1", entries });
    expect(restored?.requestKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(restored?.classOverrides).toEqual([]);
    expect(restored?.studentOverrides).toEqual([]);
    expect(restored?.materialSelectionInitialized).toBe(true);
    expect(restored?.pendingMaterialLessonNumber).toBeNull();
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
    expect(markup).toContain("确认范围与计划并开始生成");
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

  it("only applies successfully loaded group rosters and preserves a failed class for retry", () => {
    const merged = mergeLoadedGroupRosterEntries(entries, new Map([
      ["session-a", ["student-b"]],
    ]));
    expect(merged[0].studentIds).toEqual(["student-b"]);
    expect(merged[1]).toBe(entries[1]);
    expect(merged[1].studentIds).toEqual(["student-c"]);
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

  it("does not accept drop or input files while material intake is busy", () => {
    expect(shouldAcceptMaterialFiles(true, 1)).toBe(false);
    expect(shouldAcceptMaterialFiles(false, 0)).toBe(false);
    expect(shouldAcceptMaterialFiles(false, 2)).toBe(true);
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
