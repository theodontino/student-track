"use client";

import { useState } from "react";
import { Button, SegmentedControl, Textarea } from "@/components/ui";
import type { FeedbackPlanItemGenerationConfig } from "@/lib/feedback-plan";
import type { FeedbackContextStudent } from "./context-types";
import type { FeedbackTaskClassDraft, FeedbackTaskClassOverrideDraft, FeedbackTaskDraftV2 } from "./feedback-task-state";
import { FeedbackPlanGenerationConfigDialog, independentConfigFromCommon } from "./FeedbackPlanGenerationConfigDialog";
import styles from "./unified-feedback-workspace.module.css";

type Props = {
  draft: FeedbackTaskDraftV2;
  plannedSessionCodes?: string[];
  studentsBySession: Record<string, FeedbackContextStudent[]>;
  scopeSummary: string;
  busy: boolean;
  onEntry: (sessionCode: string, patch: Partial<FeedbackTaskClassDraft>) => void;
  onDraft: (patch: Partial<FeedbackTaskDraftV2>) => void;
  onClassOverrideChange: (sessionCode: string, override: Omit<FeedbackTaskClassOverrideDraft, "sessionCode"> | null) => void;
  onStudentOverrideChange: (studentId: string, generationConfig: FeedbackPlanItemGenerationConfig | null) => void | Promise<void>;
  onBack: () => void;
  onStart: () => void;
  onSave?: () => void;
  saveState?: "idle" | "dirty" | "saving" | "saved" | "error";
  saveMessage?: string;
};

function inheritedConfig(draft: FeedbackTaskDraftV2, entry: FeedbackTaskClassDraft): FeedbackPlanItemGenerationConfig {
  const classOverride = draft.classOverrides.find((override) => override.sessionCode === entry.sessionCode);
  return {
    version: 1,
    type: draft.revisionSource?.type ?? "event_micro",
    outputRequirement: classOverride?.outputRequirement ?? draft.outputRequirement,
    generationPreferences: {
      ...draft.preferences,
      ...classOverride?.preferences,
      moduleKeys: classOverride?.preferences?.moduleKeys ? [...classOverride.preferences.moduleKeys] : [...draft.preferences.moduleKeys],
    },
  };
}

export function includeIndependentFeedbackStudent(entry: FeedbackTaskClassDraft, studentId: string) {
  if (entry.studentIds.includes(studentId) && entry.studentSelectionInitialized) return entry;
  return {
    ...entry,
    studentIds: entry.studentIds.includes(studentId) ? entry.studentIds : [...entry.studentIds, studentId],
    studentSelectionInitialized: true,
  };
}

export function TaskConfirmationStage(props: Props) {
  const [studentTarget, setStudentTarget] = useState<{ student: FeedbackContextStudent; entry: FeedbackTaskClassDraft } | null>(null);
  const classUpdate = props.draft.revisionSource?.type === "class_update";
  const plannedSessionCodes = new Set(props.plannedSessionCodes ?? props.draft.plannedSessionCodes);
  const selectedEntries = props.draft.entries.filter((entry) => entry.selected && !plannedSessionCodes.has(entry.sessionCode));
  const selectedCount = selectedEntries.reduce((total, entry) => total + entry.studentIds.length, 0);

  function toggleStudent(entry: FeedbackTaskClassDraft, studentId: string) {
    const selected = new Set(entry.studentIds);
    props.onEntry(entry.sessionCode, {
      studentIds: selected.has(studentId) ? entry.studentIds.filter((id) => id !== studentId) : [...entry.studentIds, studentId],
      studentSelectionInitialized: true,
    });
  }

  function updateClassOverride(entry: FeedbackTaskClassDraft, patch: { outputRequirement?: string; preferences?: FeedbackTaskClassOverrideDraft["preferences"] }) {
    const current = props.draft.classOverrides.find((override) => override.sessionCode === entry.sessionCode);
    props.onClassOverrideChange(entry.sessionCode, {
      outputRequirement: patch.outputRequirement ?? current?.outputRequirement,
      preferences: patch.preferences ? { ...current?.preferences, ...patch.preferences } : current?.preferences,
    });
  }

  return <div className={styles.planStage}>
    <section className={styles.planDocumentHeader} aria-label="反馈计划文档">
      <label><span>计划名称</span><input aria-label="计划名称" maxLength={120} value={props.draft.displayName} disabled={props.busy} onChange={(event) => props.onDraft({ displayName: event.target.value })} placeholder="例如：九月第一次课后反馈" /></label>
      <div><span role="status">{props.saveState === "saving" ? "保存中…" : props.saveState === "dirty" ? "有未保存修改" : props.saveState === "error" ? props.saveMessage || "保存失败，可重试" : props.saveState === "saved" ? "已自动保存" : "建立后会自动保存"}</span>{props.onSave && <><Button uiSize="sm" variant="secondary" onClick={props.onSave} disabled={props.busy || props.saveState === "saving" || props.saveState === "saved"}>{props.saveState === "saving" ? "保存中…" : props.saveState === "saved" ? "已保存" : "保存"}</Button><kbd>Ctrl/⌘ S</kbd></>}</div>
    </section>
    <section className={styles.readonlyScopeSummary}>
      <div><span>本轮范围</span><strong>{props.scopeSummary}</strong><small>录入与课堂事实已经确认；如需修改班级或课次，请返回录入步骤。</small></div>
      <Button variant="ghost" onClick={props.onBack} disabled={props.busy}>返回录入</Button>
    </section>

    <section className={styles.strategy}>
      <div className={styles.strategyHeading}><div><strong>{props.draft.mode === "group" ? "班级组默认反馈计划" : "本班默认反馈计划"}</strong><span>系统优先选择有推荐理由或本次测评材料的学生；没有推荐时默认全班。你手动修改后，后续材料不会覆盖选择。</span></div></div>
      <div className={styles.strategyRows}>
        <label>生成方式<select value={props.draft.generationApproach} disabled={props.busy} onChange={(event) => props.onDraft({ generationApproach: event.target.value as FeedbackTaskDraftV2["generationApproach"] })}><option value="restricted">受限反馈</option><option value="free">自由反馈</option></select><small>{props.draft.generationApproach === "restricted" ? "先规划可披露内容，再由写作模型只依据这份受限输入成稿。" : "单阶段直接根据当前学生已冻结、已确认的材料成稿，仍执行程序核验。"}</small></label>
        <label>详略<SegmentedControl label="详略" value={props.draft.preferences.length} disabled={props.busy} onChange={(value) => props.onDraft({ preferences: { ...props.draft.preferences, length: value as FeedbackTaskDraftV2["preferences"]["length"] } })} items={[{ value: "inherit", label: "随家庭偏好" }, { value: "short", label: "简洁" }, { value: "standard", label: "标准" }, { value: "detailed", label: "详细" }]} /></label>
        <label>语气<SegmentedControl label="语气" value={props.draft.preferences.tone} disabled={props.busy} onChange={(value) => props.onDraft({ preferences: { ...props.draft.preferences, tone: value as FeedbackTaskDraftV2["preferences"]["tone"] } })} items={[{ value: "inherit", label: "随现有偏好" }, { value: "gentle", label: "温和" }, { value: "professional", label: "专业" }]} /></label>
        <label className={styles.requirement}>总体要求<Textarea rows={3} value={props.draft.outputRequirement} disabled={props.busy} onChange={(event) => props.onDraft({ outputRequirement: event.target.value })} /></label>
      </div>
    </section>

    <section className={styles.studentPlanGroups} aria-label="按班级选择学生与反馈计划">
      {selectedEntries.map((entry, entryIndex) => {
        const students = props.studentsBySession[entry.sessionCode] ?? [];
        const selected = new Set(entry.studentIds);
        const classOverride = props.draft.classOverrides.find((override) => override.sessionCode === entry.sessionCode);
        return <details key={entry.sessionCode} className={styles.studentClassGroup} open={props.draft.mode === "single" || entryIndex === 0}>
          <summary><div><strong>{entry.className}</strong><span>{classUpdate ? "1 条班级公共反馈" : `${entry.studentIds.length}/${students.length} 名学生 · ${entry.studentSelectionInitialized ? "教师已调整范围" : "系统默认范围（优先课堂关注/测评）"}`} · {classOverride ? "已调整班级默认" : "跟随班级组默认"}</span></div><span>{classUpdate ? "班级范围" : props.draft.mode === "group" ? "展开学生" : "学生范围"}</span></summary>
          <div className={styles.studentClassBody}>
            <div className={styles.studentClassActions}><div>{!classUpdate && <><Button uiSize="sm" variant="ghost" onClick={() => props.onEntry(entry.sessionCode, { studentIds: students.map((student) => student.id), studentSelectionInitialized: true })} disabled={props.busy}>全选</Button><Button uiSize="sm" variant="ghost" onClick={() => props.onEntry(entry.sessionCode, { studentIds: [], studentSelectionInitialized: true })} disabled={props.busy}>清空</Button></>}</div><details className={styles.classDefaultEditor}><summary>调整班级默认</summary><div className={styles.classOverrideFields}><label>班级默认总体要求<Textarea rows={2} value={classOverride?.outputRequirement ?? props.draft.outputRequirement} disabled={props.busy} onChange={(event) => updateClassOverride(entry, { outputRequirement: event.target.value })} /></label><label>班级默认详略<select value={classOverride?.preferences?.length ?? props.draft.preferences.length} disabled={props.busy} onChange={(event) => updateClassOverride(entry, { preferences: { length: event.target.value as FeedbackTaskDraftV2["preferences"]["length"] } })}><option value="inherit">随家庭偏好</option><option value="short">简洁</option><option value="standard">标准</option><option value="detailed">详细</option></select></label><label>班级默认语气<select value={classOverride?.preferences?.tone ?? props.draft.preferences.tone} disabled={props.busy} onChange={(event) => updateClassOverride(entry, { preferences: { tone: event.target.value as FeedbackTaskDraftV2["preferences"]["tone"] } })}><option value="inherit">随现有偏好</option><option value="gentle">温和</option><option value="professional">专业</option></select></label>{classOverride && <Button variant="ghost" onClick={() => props.onClassOverrideChange(entry.sessionCode, null)} disabled={props.busy}>恢复班级组默认</Button>}</div></details></div>
            {classUpdate ? <p>班级整体反馈会读取这个班的已确认事实，并生成一条公共内容，不按学生拆分计划。</p> : <div className={styles.studentRows}>{students.map((student) => {
              const studentOverride = props.draft.studentOverrides.find((override) => override.studentId === student.id);
              return <article key={student.id} className={selected.has(student.id) ? styles.studentRowSelected : ""}>
                <label><input type="checkbox" checked={selected.has(student.id)} disabled={props.busy} onChange={() => toggleStudent(entry, student.id)} /><span><strong>{student.name}</strong><small>{student.studentId}{student.feedbackRecommendationReasons?.length ? ` · 推荐：${student.feedbackRecommendationReasons.join("；")}` : ""}</small></span></label>
                <span className={studentOverride ? styles.overrideState : ""}>{studentOverride ? "已单独设置" : "跟随默认"}</span>
                <div><>
                  <Button uiSize="sm" variant="ghost" onClick={() => setStudentTarget({ student, entry })} disabled={props.busy}>{studentOverride ? "调整设置" : "单独设置"}</Button>
                  {studentOverride && <Button uiSize="sm" variant="ghost" onClick={() => void props.onStudentOverrideChange(student.id, null)} disabled={props.busy}>恢复默认</Button>}
                </></div>
              </article>;
            })}</div>}
          </div>
        </details>;
      })}
    </section>

    <div className={styles.stickyPlanActions}><div><strong>{classUpdate ? `${selectedEntries.length} 个班级公共反馈` : `${selectedEntries.length} 个班、${selectedCount} 名学生`}</strong><span>先建立可恢复草稿；进入计划文档后会自动保存，确认无误再单独开始生成。</span></div><Button onClick={props.onStart} disabled={props.busy || !props.draft.displayName.trim() || (!classUpdate && selectedEntries.some((entry) => entry.studentIds.length === 0))}>{props.busy ? "正在建立计划…" : "建立可保存计划"}</Button></div>

    {studentTarget && <FeedbackPlanGenerationConfigDialog
      open
      studentName={studentTarget.student.name}
      initialConfig={independentConfigFromCommon(inheritedConfig(props.draft, studentTarget.entry), props.draft.studentOverrides.find((override) => override.studentId === studentTarget.student.id)?.generationConfig)}
      busy={props.busy}
      onClose={() => setStudentTarget(null)}
      onSave={async (generationConfig) => {
        const latestEntry = props.draft.entries.find((entry) => entry.sessionCode === studentTarget.entry.sessionCode) ?? studentTarget.entry;
        const nextEntry = includeIndependentFeedbackStudent(latestEntry, studentTarget.student.id);
        if (nextEntry !== latestEntry) {
          props.onEntry(latestEntry.sessionCode, {
            studentIds: nextEntry.studentIds,
            studentSelectionInitialized: true,
          });
        }
        await props.onStudentOverrideChange(studentTarget.student.id, generationConfig);
        setStudentTarget(null);
      }}
      onReset={props.draft.studentOverrides.some((override) => override.studentId === studentTarget.student.id) ? async () => { await props.onStudentOverrideChange(studentTarget.student.id, null); setStudentTarget(null); } : undefined}
    />}
  </div>;
}
