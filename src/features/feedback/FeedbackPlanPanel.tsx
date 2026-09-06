"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, Section, StatusBanner, Textarea } from "@/components/ui";
import {
  FEEDBACK_CLOSURES_BY_TYPE,
  FEEDBACK_MODULES,
  defaultFeedbackGenerationPreferences,
  isHardFeedbackAuditIssue,
  type FeedbackCompositionPlan,
  type FeedbackModule,
  type FeedbackClosureType,
  type FeedbackPlanType,
  type FeedbackPlanItemGenerationConfig,
  type FeedbackAuditSnapshot,
  type FeedbackEvidenceBundle,
} from "@/lib/feedback-plan";
import { stripFeedbackInternalBoundary } from "@/lib/feedback-text-safety";
import { getProductCapabilities } from "@/lib/product-edition";
import {
  feedbackGenerationApproachLabel,
  type FeedbackGenerationApproach,
} from "@/lib/feedback-generation-approach";
import type { FeedbackContextStudent } from "./context-types";
import type { StudentAssessmentEvidence } from "@/lib/feedback-materials";
import { LLMRoleAssignmentsPanel } from "@/features/system/LLMRoleAssignmentsPanel";
import { useLLMConfiguration } from "@/features/system/useLLMConfiguration";
import { StudentTrendChart, type StudentTrendMetric } from "@/features/students/StudentTrendChart";
import { FeedbackPlanGenerationConfigDialog, independentConfigFromCommon } from "./FeedbackPlanGenerationConfigDialog";

export type FeedbackPlanWorkspace = {
  activeStep: string;
  setActiveStep: (step: "prepare" | "extract" | "review" | "generate" | "export") => void;
  draftId: string;
  confirmed: boolean;
  context: { semesterId: string; className: string; sessionCode: string };
  lessonMaterial: import("@/lib/feedback-materials").LessonFeedbackMaterial;
  contextStudents: FeedbackContextStudent[];
  confirmedAssessmentEvidence: Record<string, StudentAssessmentEvidence>;
};

export type FeedbackPlanBatchControl = { active: boolean; status: string; busy?: boolean };

export type FeedbackGenerationStage = "planner" | "writer" | "free" | "deterministic_check";

type FeedbackGenerationAttemptView = {
  actualApproach: FeedbackGenerationApproach;
  status: string;
  stage?: FeedbackGenerationStage;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    kind?: "schema" | "timeout" | "connection" | "aborted" | "service";
  };
};

interface PlanItem {
  id: string;
  studentId: string | null;
  status: string;
  finalText: string | null;
  finalTextHash: string | null;
  generationError?: string | null;
  generationConfig?: FeedbackPlanItemGenerationConfig | null;
  evidenceSnapshot: string;
  compositionSnapshot: string;
  auditSnapshot: string;
  evidence?: FeedbackEvidenceBundle | null;
  composition?: FeedbackCompositionPlan | null;
  audit?: FeedbackAuditSnapshot | null;
  itemRevision: number;
  reviewMode?: "model" | "teacher_edited";
  generationStartedAt?: string | null;
  generationCompletedAt?: string | null;
  generationDurationMs?: number | null;
  generationExecution?: {
    requestedApproach: FeedbackGenerationApproach;
    nextApproach: FeedbackGenerationApproach;
    attempts: FeedbackGenerationAttemptView[];
  } | null;
  selectedGeneration?: { inputSnapshot?: string | null } | null;
  student?: {
    name: string;
    studentId?: string;
    communicationPreference?: { preferenceSnapshot: string } | null;
    communicationPreferenceCandidates?: Array<{ id: string; preferenceSnapshot: string; evidenceSnapshot: string }>;
  } | null;
  tasks?: Array<{ id: string; action: string; status: string; dueType: string; dueDate?: string | null; dueSessionId?: string | null }>;
  attachments?: Array<{ id: string; displayName: string; mimeType: string; sizeBytes: number; sha256: string; relativeLocator: string; status: string }>;
}

interface Plan {
  id: string;
  displayName?: string | null;
  type: FeedbackPlanType;
  outputRequirement: string;
  status: string;
  archivedAt?: string | null;
  legacyReadonly?: boolean;
  generationApproach?: FeedbackGenerationApproach | null;
  generationApproachLabel?: string;
  generationStartedAt?: string | null;
  generationCompletedAt?: string | null;
  planRevision?: number;
  sessionId?: string | null;
  rangeStartSessionId?: string | null;
  rangeEndSessionId?: string | null;
  input?: { generationPreferences?: { closureType: string; moduleKeys: string[]; length?: string; tone?: string } } | null;
  items: PlanItem[];
  generationProgress?: { total: number; queued: number; running: number; completed: number; failed: number; stale: number };
  generationTiming?: { startedAt: string | null; completedAt: string | null; elapsedMs: number; completedItems: number; averageItemMs: number | null; itemsPerMinute: number | null; asOf: string };
  exportRuns?: Array<{ id: string; mode: string; manifestHash: string; isRepeat?: boolean; createdAt: string }>;
}

export type FeedbackItemDraft = { text: string; revision: number };

export function feedbackPlanItemShouldAutoSave(
  item: { status: string; finalText?: string | null; studentId?: string | null; student?: unknown | null },
  draft: FeedbackItemDraft | undefined,
  saving: boolean,
  archived: boolean,
) {
  return Boolean(
    draft
    && draft.text !== (item.finalText ?? "")
    && !saving
    && !archived
    && (!item.studentId || item.student)
    && !["approved", "exported", "generating", "queued", "pause_requested"].includes(item.status),
  );
}

export function syncFeedbackItemDrafts(
  current: Record<string, FeedbackItemDraft>,
  incoming: Array<{ id: string; text: string; revision: number }>,
) {
  const next = { ...current };
  for (const item of incoming) {
    const existing = next[item.id];
    const hasLocalEdit = Boolean(existing && existing.text !== item.text);
    const serverRevisionChanged = Boolean(existing && existing.revision !== item.revision);
    if (!existing || !hasLocalEdit || serverRevisionChanged) next[item.id] = { text: item.text, revision: item.revision };
  }
  return next;
}

interface RosterCandidate {
  id: string;
  name: string;
  studentId: string;
  classId: string;
  rosterStatus: "ACTIVE" | "INACTIVE";
}

interface TaskDraft {
  action: string;
  dueType: "session" | "date";
  dueSessionId: string;
  dueDate: string;
}

interface ApiFailurePayload {
  error?: string | { message?: string; code?: string };
  code?: string;
}

function apiFailureMessage(payload: ApiFailurePayload | null | undefined, fallback: string) {
  if (typeof payload?.error === "string") return payload.error;
  return payload?.error?.message || fallback;
}

function apiFailureCode(payload: ApiFailurePayload | null | undefined) {
  return payload?.code || (typeof payload?.error === "object" ? payload.error.code : undefined);
}

const typeLabels: Record<FeedbackPlanType, string> = {
  class_update: "班级公共反馈",
  event_micro: "事件型微反馈",
  stage_trend: "阶段趋势反馈",
  course_end: "结课教学总结",
};

const closureLabels: Record<string, string> = {
  informational: "知情型",
  positive_recognition: "具体认可",
  teacher_resolved: "课堂已处理",
  home_cooperation: "家庭配合",
  continued_observation: "后续观察",
};

const moduleLabels: Record<string, string> = {
  lesson_scope: "本课内容",
  key_difficulty: "关键难点",
  class_handling: "班级处理",
  homework_review: "作业与复习",
  next_lesson_link: "下次课衔接",
  observed_moment: "具体表现",
  teacher_interpretation: "教师判断",
  teacher_intervention: "老师已经做了什么",
  intervention_outcome: "处理结果",
  parent_action: "家长最低动作",
  followup_observation: "后续观察",
  starting_point: "阶段起点",
  recent_trend: "近期趋势",
  stable_capability: "已稳定能力",
  unresolved_issue: "尚未稳定问题",
  teacher_support: "阶段内教师支持",
  next_stage_focus: "下一阶段重点",
  starting_state: "起点状态",
  evidence_backed_change: "有证据的变化",
  remaining_gap: "剩余断点",
  next_stage_learning_path: "下一阶段学习路径",
};

const moduleDescriptions: Record<string, string> = {
  lesson_scope: "本课讲了什么",
  key_difficulty: "最需要理解的难点",
  class_handling: "课堂如何处理",
  homework_review: "作业或复习建议",
  next_lesson_link: "与下次课如何衔接",
  observed_moment: "学生本次具体表现",
  teacher_interpretation: "教师对表现的判断",
  teacher_intervention: "老师已经采取的处理",
  intervention_outcome: "处理后的结果",
  parent_action: "家长可以做的最低动作",
  followup_observation: "后续需要观察什么",
  starting_point: "阶段开始时的状态",
  recent_trend: "近期变化趋势",
  stable_capability: "已经稳定的能力",
  unresolved_issue: "尚未稳定的问题",
  teacher_support: "阶段内已有的教师支持",
  next_stage_focus: "下一阶段重点",
  starting_state: "学习阶段的起点",
  evidence_backed_change: "有证据支持的变化",
  remaining_gap: "仍然存在的断点",
  next_stage_learning_path: "下一阶段学习路径",
};

const preferenceLabels: Record<string, string> = {
  unknown: "未设置",
  short: "简短",
  standard: "标准",
  detailed: "详细",
  flexible: "长短均可",
  text: "文字",
  voice: "语音",
  either: "文字或语音均可",
  accepted: "接受微信电话",
  not_accepted: "不接受微信电话",
  teacher_conclusion: "教师结论",
  classroom_example: "课堂例子",
  data_trend: "数据趋势",
  plain: "生活化",
  basic: "基础术语",
  professional: "专业细节",
  inform_only: "只需知情",
  remind_confirm: "提醒确认",
  observe_report: "观察反馈",
  simple_check: "简单检查",
  every_session: "每次反馈",
  stage_only: "阶段总结",
  exception_only: "仅异常时",
};

function preferenceLabel(value: unknown) {
  return typeof value === "string" ? preferenceLabels[value] ?? value : "未设置";
}

export function feedbackPlanItemActualApproach(item: {
  generationExecution?: { attempts: Array<{ actualApproach: FeedbackGenerationApproach }> } | null;
}) {
  const attempts = item.generationExecution?.attempts ?? [];
  return attempts[attempts.length - 1]?.actualApproach ?? null;
}

export function feedbackGenerationStageLabel(stage: FeedbackGenerationStage | null | undefined) {
  if (stage === "planner") return "Planner 规划";
  if (stage === "writer") return "Writer 撰写";
  if (stage === "free") return "自由生成";
  if (stage === "deterministic_check") return "程序核验";
  return null;
}

function feedbackGenerationErrorKindLabel(kind: "schema" | "timeout" | "connection" | "aborted" | "service" | undefined) {
  if (kind === "schema") return "结构不合规";
  if (kind === "timeout") return "模型超时";
  if (kind === "connection") return "连接失败";
  if (kind === "aborted") return "已中断";
  if (kind === "service") return "模型服务失败";
  return null;
}

export function feedbackPlanItemCurrentStageLabel(item: {
  generationExecution?: { attempts: Array<{
    status: string;
    stage?: FeedbackGenerationStage;
    actualApproach?: FeedbackGenerationApproach;
  }> } | null;
}) {
  const attempts = item.generationExecution?.attempts ?? [];
  const current = attempts[attempts.length - 1];
  const label = current?.status === "running" ? feedbackGenerationStageLabel(current.stage) : null;
  return label ? `${label}中` : null;
}

export function feedbackPlanGenerationIsActive(plan: {
  status?: string;
  items?: Array<{
    status: string;
    generationExecution?: { attempts: Array<{ status: string }> } | null;
  }>;
} | null | undefined) {
  const activeStatuses = ["queued", "generating", "pause_requested"];
  return Boolean(plan && (
    activeStatuses.includes(plan.status ?? "")
    || plan.items?.some((item) => (
      activeStatuses.includes(item.status)
      || item.generationExecution?.attempts.at(-1)?.status === "running"
    ))
  ));
}

function generationApproachDescription(approach: FeedbackGenerationApproach | null | undefined) {
  if (approach === "restricted") return "先规划可披露内容，再由写作模型只依据受限输入成稿。";
  if (approach === "free") return "单阶段直接根据当前对象已冻结、已确认的材料成稿。";
  return "旧生成方式已退役，历史配置只读；已有正文仍可复核、批准和导出。需要继续生成时，请另存为并明确选择受限反馈或自由反馈。";
}

export function feedbackPlanUsesRetiredLegacyGeneration(plan: { generationApproach?: FeedbackGenerationApproach | null; legacyReadonly?: boolean }) {
  return plan.legacyReadonly === true;
}

export function feedbackPlanConfiguredApproachLabel(plan: {
  generationApproach?: FeedbackGenerationApproach | null;
  generationApproachLabel?: string;
  legacyReadonly?: boolean;
}) {
  if (plan.legacyReadonly === true) return plan.generationApproachLabel?.trim() || feedbackGenerationApproachLabel(null);
  if (plan.generationApproach) return plan.generationApproachLabel?.trim() || feedbackGenerationApproachLabel(plan.generationApproach);
  return "生成方式未标注";
}

function configuredGenerationApproachDescription(plan: Plan) {
  if (plan.legacyReadonly === true) return generationApproachDescription(null);
  if (plan.generationApproach) return generationApproachDescription(plan.generationApproach);
  return "生成方式未标注，请刷新计划后再继续生成。已有正文仍可复核。";
}

export function feedbackPlanItemShowsApproval(status: string) {
  return !["approved", "exported"].includes(status);
}

function itemGenerationSummary(plan: Plan, item: PlanItem) {
  const currentStage = feedbackPlanItemCurrentStageLabel(item);
  if (currentStage) return currentStage;
  const actual = feedbackPlanItemActualApproach(item);
  if (actual) return `${feedbackGenerationApproachLabel(actual)} · 实际执行`;
  if (plan.legacyReadonly === true) return feedbackGenerationApproachLabel(null);
  if (!plan.generationApproach) return "生成方式未标注";
  return `${feedbackGenerationApproachLabel(plan.generationApproach)} · 尚未执行`;
}

const generationLengthLabels: Record<string, string> = {
  inherit: "随家庭偏好",
  short: "简洁",
  standard: "标准",
  detailed: "详细",
};

const generationToneLabels: Record<string, string> = {
  inherit: "随家庭偏好",
  warm: "温和",
  professional: "专业",
};

function generationPreferenceLabel(value: string | undefined, labels: Record<string, string>) {
  return labels[value ?? "inherit"] ?? value ?? labels.inherit;
}

function formatDuration(milliseconds: number | null | undefined) {
  if (milliseconds === null || milliseconds === undefined) return "—";
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时 ${String(minutes).padStart(2, "0")}分 ${String(seconds).padStart(2, "0")}秒`;
  if (minutes > 0) return `${minutes}分 ${String(seconds).padStart(2, "0")}秒`;
  return `${seconds}秒`;
}

const statusLabels: Record<string, string> = {
  draft: "草稿",
  queued: "排队中",
  generating: "生成中",
  pause_requested: "即将暂停",
  paused: "已暂停",
  generation_failed: "部分生成失败",
  in_review: "待复核",
  partially_approved: "部分已批准",
  approved: "已批准",
  partially_exported: "部分已导出",
  exported: "已导出",
  stale: "证据已变化",
  evidence_ready: "证据就绪",
  needs_review: "待教师批准",
  exported_item: "已导出",
};

function parseObject(value: string | Record<string, unknown> | undefined | null) {
  if (value && typeof value === "object") return value as Record<string, any>;
  if (!value) return {} as Record<string, any>;
  try { return JSON.parse(value) as Record<string, any>; } catch { return {}; }
}

function parseComposition(value: string | undefined, planType?: FeedbackPlanType, parsed?: FeedbackCompositionPlan | null): FeedbackCompositionPlan {
  if (parsed) return parsed;
  const compositionData = parseObject(value);
  const modules = Array.isArray(compositionData.modules)
    ? compositionData.modules.filter((module): module is FeedbackModule => Boolean(module && typeof module.key === "string"))
    : [];
  return {
    version: 1,
    closureType: typeof compositionData.closureType === "string"
      ? compositionData.closureType as FeedbackCompositionPlan["closureType"]
      : planType === "class_update" ? "informational" : "positive_recognition",
    needParentAction: compositionData.needParentAction === true,
    parentAction: compositionData.parentAction && typeof compositionData.parentAction === "object" ? compositionData.parentAction : null,
    modules,
    evidenceCoverage: Array.isArray(compositionData.evidenceCoverage)
      ? compositionData.evidenceCoverage.filter((entry): entry is FeedbackCompositionPlan["evidenceCoverage"][number] => (
        Boolean(entry && typeof entry.evidenceId === "string" && typeof entry.statement === "string")
      ))
      : [],
    draftFeedback: typeof compositionData.draftFeedback === "string" ? compositionData.draftFeedback : "",
  };
}

function planStatusLabel(status: string) {
  return statusLabels[status] ?? status;
}

function auditStatus(item: PlanItem) {
  const audit = item.audit ?? parseObject(item.auditSnapshot);
  const issues = Array.isArray(audit.items) ? audit.items as Array<{ code?: string }> : [];
  if (issues.some((issue) => typeof issue.code === "string" && isHardFeedbackAuditIssue(issue.code))) return "blocked";
  return audit.status === "pass" ? "pass" : "needs_review";
}

type AuditIssue = FeedbackAuditSnapshot["items"][number];

const auditIssueGuidance: Record<string, { area: string; title: string; impact: string; action: string }> = {
  empty_text: { area: "教师最终正文", title: "正文为空", impact: "没有可供教师批准和导出的反馈文本。", action: "在正文编辑框补充反馈并保存。" },
  restricted_writer_output_invalid: { area: "受限 Writer 草稿", title: "草稿未通过程序核验", impact: "草稿已保留供教师检查，但当前不能批准、导出或生成企微草稿。", action: "逐字核对并实际修改正文，保存后系统会重新执行程序核验。" },
  recipient_mismatch: { area: "正文称呼", title: "反馈对象可能写错", impact: "面向家长的反馈使用了直接对学生说话的表达。", action: "把“你要……”等学生式称呼改为面向家长的表述。" },
  module_not_allowed: { area: "生成阶段结构 → 模块", title: "反馈类型与模块不匹配", impact: "当前计划类型不允许使用其中一个模块。", action: "新建计划时选择当前类型允许的模块。" },
  evidence_ref_missing: { area: "模块引用证据", title: "模块引用的证据已经不存在", impact: "正文结构无法追溯到本计划冻结的证据。", action: "对照事实修正正文；如需模型重写，请建立一份修正计划。" },
  evidence_coverage_duplicate: { area: "正文证据覆盖", title: "同一证据被重复登记", impact: "系统无法准确判断正文是否完整保留证据。", action: "先修正并保存正文；如需模型重写，请建立修正计划，并保留此错误代码用于排查。" },
  evidence_coverage_unknown: { area: "正文证据覆盖", title: "覆盖声明指向了无效证据", impact: "模型声明使用了不属于本课教学或测评的材料。", action: "对照本课事实和出门测详情修改正文，然后保存；如需模型重写，请建立修正计划。" },
  evidence_coverage_unsubstantiated: { area: "教师最终正文", title: "正文表述与原始证据对应不清", impact: "程序没有在正文中找到足够关键词来证明这句话来自对应证据。", action: "对照左侧本课事实和出门测详情，确认无误后可保留；否则改写为更贴近原始事实的表述。" },
  final_evidence_omitted: { area: "教师最终正文", title: "部分已确认证据没有写入正文", impact: "反馈可能遗漏本课事实或出门测结果，但教师可以有意删减。", action: "查看提示中的证据和下方出门测详情；需要时补入正文，不重要时可直接确认。" },
  unconfirmed_evidence: { area: "证据来源", title: "正文使用了尚未确认的材料", impact: "存在把模型猜测或未复核材料当成学生事实的风险，因此禁止批准。", action: "回到复核步骤确认对应记录，或从正文和模块中移除这项材料后重新核验。" },
  parent_action_mismatch: { area: "生成阶段结构 → 家长任务", title: "家长任务开关与内容不一致", impact: "正文结构无法确定是否真的要求家庭配合。", action: "新建计划时选择家长动作模块，并由教师复核具体内容。" },
  parent_action_disabled: { area: "家长任务", title: "未启用家长任务却写入了任务", impact: "导出文本可能意外要求家长执行动作。", action: "启用家长动作模块，或删除家庭任务内容。" },
  parent_action_module_missing: { area: "生成阶段结构 → 家长动作", title: "家长任务没有对应模块", impact: "任务内容没有进入受控的反馈结构。", action: "新建计划时加入家长动作模块。" },
  parent_action_content_missing: { area: "生成阶段结构 → 家长动作", title: "家长动作模块缺少具体内容", impact: "正文提出了家庭配合，但没有明确动作或完成标准。", action: "补充具体、可执行的家长动作，或新建计划取消该模块。" },
  teacher_intervention_unconfirmed: { area: "教师处理证据", title: "写了教师处理，但没有确认记录", impact: "正文可能把未发生的教师介入写成事实。", action: "回到复核补充并确认教师处理，或删除对应模块和表述。" },
  intervention_outcome_without_action: { area: "教师处理结果", title: "只有处理结果，没有处理动作", impact: "家长看不到结果是由什么措施产生的。", action: "补充教师处理模块，或删除孤立的处理结果。" },
  followup_without_task: { area: "后续观察", title: "承诺跟进但没有教师任务", impact: "反馈形成了未来承诺，但系统没有可追踪的执行任务。", action: "在卡片底部创建教师任务并设置截止课次或日期。" },
  closure_requires_followup: { area: "生成阶段结构 → 结尾类型", title: "“继续观察”结尾缺少跟进内容", impact: "结尾承诺继续观察，但正文结构没有后续观察模块。", action: "新建计划时同时选择后续观察模块。" },
  closure_requires_intervention: { area: "生成阶段结构 → 结尾类型", title: "“教师已处理”结尾缺少处理证据", impact: "结尾声称已经处理，但没有已确认的教师处理模块。", action: "新建计划时选择教师处理模块，并确认对应事实。" },
  closure_requires_parent_action: { area: "生成阶段结构 → 结尾类型", title: "“家庭配合”结尾缺少家长动作", impact: "结尾要求配合，但没有可执行的家庭任务。", action: "新建计划时同时选择家长动作模块。" },
  closure_not_allowed: { area: "生成阶段结构 → 结尾类型", title: "当前反馈类型不能使用这个结尾", impact: "反馈类型和收尾方式不符合既定规则。", action: "新建计划时选择当前类型允许的结尾。" },
  internal_content_leak: { area: "教师最终正文", title: "正文包含内部工作信息", impact: "家长可能看到续班研判、内部标签、模型过程或教师任务等内部内容。", action: "删除内部信息，只保留可面向家长的教学事实和建议。" },
  cross_student_content: { area: "教师最终正文", title: "正文出现了其他学生姓名", impact: "存在错发学生信息和隐私泄露风险，因此禁止批准。", action: "删除或改正其他学生姓名，并重新核对整段正文。" },
  implicit_parent_action: { area: "教师最终正文", title: "正文要求家长行动，但结构中未登记", impact: "家长任务绕过了可控模块，可能造成未经确认的要求。", action: "启用家长动作模块并确认内容，或删除要求家长执行的句子。" },
  promise_without_task: { area: "教师最终正文", title: "正文承诺后续动作，但没有教师任务", impact: "“后续关注/下次检查”等承诺没有执行记录。", action: "在卡片底部创建教师任务，或删除未来承诺。" },
  promise_requires_teacher: { area: "教师最终正文", title: "检测到教师未来承诺", impact: "任务已经存在，但仍需确认承诺范围和截止节点是否准确。", action: "核对下方教师任务与正文一致后再批准。" },
};

export function feedbackPlanAuditIssueGuidance(code: string) {
  return auditIssueGuidance[code] ?? {
    area: "程序核验",
    title: "发现未归类的核验问题",
    impact: "系统无法自动判断这项问题是否会影响最终反馈。",
    action: "先根据检测结果核对正文；如无法判断，请保留错误代码并反馈。",
  };
}

function describeAuditIssue(issue: AuditIssue) {
  return feedbackPlanAuditIssueGuidance(issue.code);
}

function auditStatusLabel(status: ReturnType<typeof auditStatus>) {
  if (status === "blocked") return "阻断，必须修改";
  if (status === "needs_review") return "需教师确认";
  return "通过";
}

function pendingAuditMessage(status: string) {
  if (status === "evidence_ready") return "本条尚未开始生成，程序会在正文生成后核对证据、学生身份、任务和结构。";
  if (status === "queued") return "本条仍在生成队列中，当前没有可供核验的最终正文。";
  if (status === "generating" || status === "pause_requested") return "本条正在生成，程序核验将在正文保存后自动执行。";
  if (status === "generation_failed") return "本条生成失败，当前结果不能视为核验通过；请在当前学生上重试。";
  if (status === "stale") return "本条来源信息已经变化，旧核验结果不再作为批准依据；请保留现有正文并复核，或建立修正计划。";
  return null;
}

function canRegenerate(item: PlanItem) {
  return item.status === "evidence_ready";
}

async function persistFeedbackItemDraft(planId: string, item: PlanItem, draft: FeedbackItemDraft) {
  const response = await fetch(`/api/report/feedback-plans/${planId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "item", itemId: item.id, patch: { finalText: draft.text, reviewMode: "teacher_edited", expectedItemRevision: draft.revision } }),
  });
  const payload = await response.json() as ApiFailurePayload & { item?: PlanItem };
  if (!response.ok) throw new Error(apiFailureMessage(payload, "保存反馈失败"));
  if (!payload.item) throw new Error("保存反馈成功，但返回结果不完整");
  return payload.item;
}

const generatedPlanStatuses = new Set([
  "queued", "generating", "pause_requested", "paused", "generation_failed",
  "in_review", "partially_approved", "approved", "partially_exported", "exported",
]);

function planHasGenerationTrace(plan: Plan) {
  return Boolean(plan.generationStartedAt || plan.generationCompletedAt)
    || generatedPlanStatuses.has(plan.status)
    || plan.items.some((item) => Boolean(item.finalText || item.selectedGeneration)
      || ["queued", "generating", "pause_requested", "paused", "generation_failed", "needs_review", "approved", "exported"].includes(item.status));
}

export interface FeedbackPlanPanelProps {
  workspace: FeedbackPlanWorkspace;
  presentation?: "legacy" | "studio";
  batchControl?: FeedbackPlanBatchControl;
  focusItemId?: string;
  externalNavigator?: boolean;
  onNextItem?: (currentItemId: string) => void;
}

export function FeedbackPlanPanel({ workspace, presentation = "legacy", batchControl, focusItemId, externalNavigator = false, onNextItem }: FeedbackPlanPanelProps) {
  const showPanel = workspace.activeStep === "review" || workspace.activeStep === "generate" || workspace.activeStep === "export";
  const requestedPlanId = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("planId");
  const [type, setType] = useState<FeedbackPlanType>("event_micro");
  const [generationApproach, setGenerationApproach] = useState<FeedbackGenerationApproach>("restricted");
  const [generationClosureType, setGenerationClosureType] = useState<string>(defaultFeedbackGenerationPreferences("event_micro").closureType);
  const [generationModuleKeys, setGenerationModuleKeys] = useState<string[]>(defaultFeedbackGenerationPreferences("event_micro").moduleKeys);
  const [outputRequirement, setOutputRequirement] = useState("自然地记录本次最值得家长了解的教学信息，默认采用家庭已确认的表达偏好。");
  const [sessionMeta, setSessionMeta] = useState<{ classId: string; sessionId: string } | null>(null);
  const [rangeSessions, setRangeSessions] = useState<Array<{ id: string; code: string; date: string; semesterNumber: number }>>([]);
  const [rangeContextStudents, setRangeContextStudents] = useState<FeedbackContextStudent[]>([]);
  const [rangeStartSessionId, setRangeStartSessionId] = useState("");
  const [rangeEndSessionId, setRangeEndSessionId] = useState("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [planLoading, setPlanLoading] = useState(Boolean(requestedPlanId));
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [studentOverrides, setStudentOverrides] = useState<Record<string, FeedbackPlanItemGenerationConfig>>({});
  const [independentStudentTarget, setIndependentStudentTarget] = useState<{ id: string; name: string } | null>(null);
  const [independentItemTarget, setIndependentItemTarget] = useState<{ item: PlanItem; studentName: string } | null>(null);
  const [inactiveCandidates, setInactiveCandidates] = useState<RosterCandidate[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, FeedbackItemDraft>>({});
  const [taskDrafts, setTaskDrafts] = useState<Record<string, TaskDraft>>({});
  const [savingItemIds, setSavingItemIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [contextMetaError, setContextMetaError] = useState("");
  const [contextMetaReloadKey, setContextMetaReloadKey] = useState(0);
  const [repeatExportRequest, setRepeatExportRequest] = useState<{ planId: string; mode: "complete" | "approved_only" } | null>(null);
  const [studioFilter, setStudioFilter] = useState<"action" | "review" | "done" | "all">("action");
  const [studioItemId, setStudioItemId] = useState("");
  const candidateDefaultsKey = useRef("");
  const autoSaveAttempts = useRef<Record<string, string>>({});
  const activePlanPollSequence = useRef(0);
  const activePlanResponseSequence = useRef(0);
  const llmWorkspace = useLLMConfiguration();
  const capabilities = getProductCapabilities();

  function changePlanType(nextType: FeedbackPlanType) {
    setType(nextType);
    const defaults = defaultFeedbackGenerationPreferences(nextType);
    setGenerationClosureType(defaults.closureType);
    setGenerationModuleKeys(defaults.moduleKeys);
  }

  function commonGenerationConfig(planType: FeedbackPlanType, requirement: string, preferences?: { closureType: string; moduleKeys: string[]; length?: string; tone?: string } | null): FeedbackPlanItemGenerationConfig {
    const defaults = defaultFeedbackGenerationPreferences(planType);
    return {
      version: 1,
      type: planType,
      outputRequirement: requirement,
      generationPreferences: {
        closureType: (preferences?.closureType ?? defaults.closureType) as FeedbackClosureType,
        moduleKeys: [...(preferences?.moduleKeys ?? defaults.moduleKeys)],
        length: (preferences?.length ?? "inherit") as FeedbackPlanItemGenerationConfig["generationPreferences"]["length"],
        tone: (preferences?.tone ?? "inherit") as FeedbackPlanItemGenerationConfig["generationPreferences"]["tone"],
      },
    };
  }

  function openIndependentStudent(student: { id: string; name: string }) {
    setIndependentStudentTarget(student);
  }

  function saveIndependentStudent(config: FeedbackPlanItemGenerationConfig) {
    if (!independentStudentTarget) return;
    setStudentOverrides((current) => ({ ...current, [independentStudentTarget.id]: config }));
    setSelectedStudentIds((current) => [...new Set([...current, independentStudentTarget.id])]);
    setIndependentStudentTarget(null);
  }

  function resetIndependentStudent() {
    if (!independentStudentTarget) return;
    setStudentOverrides((current) => {
      const next = { ...current };
      delete next[independentStudentTarget.id];
      return next;
    });
    setIndependentStudentTarget(null);
  }

  function toggleGenerationModule(key: string, enabled: boolean) {
    setGenerationModuleKeys((current) => enabled
      ? [...new Set([...current, key])]
      : current.filter((candidate) => candidate !== key));
  }

  const assessmentEvidenceForStudentIds = (studentIds: string[]) => Object.fromEntries(
    studentIds.flatMap((studentId) => workspace.confirmedAssessmentEvidence[studentId]
      ? [[studentId, workspace.confirmedAssessmentEvidence[studentId]]]
      : []),
  );

  const candidateSourceStudents = type === "stage_trend" || type === "course_end"
    ? (rangeContextStudents.length ? rangeContextStudents : workspace.contextStudents)
    : workspace.contextStudents;
  const recommendedStudents = useMemo(() => candidateSourceStudents.filter((student) => (
    (student.feedbackRecommendationReasons?.length ?? 0) > 0
  )), [candidateSourceStudents]);
  const confirmedAssessmentStudentIds = useMemo(() => new Set(
    Object.keys(workspace.confirmedAssessmentEvidence).filter((studentId) => candidateSourceStudents.some((student) => student.id === studentId)),
  ), [candidateSourceStudents, workspace.confirmedAssessmentEvidence]);
  const candidateStudents = useMemo(() => {
    if (type === "event_micro") return candidateSourceStudents;
    return candidateSourceStudents.filter((student) => student.preview.today.length > 0 || student.preview.trend !== "暂无近期评分趋势");
  }, [type, candidateSourceStudents]);

  const loadPlans = useCallback(async () => {
    if (!sessionMeta) return;
    const query = new URLSearchParams({ classId: sessionMeta.classId, semesterId: workspace.context.semesterId });
    const response = await fetch(`/api/report/feedback-plans?${query.toString()}`);
    if (!response.ok) throw new Error("无法读取反馈计划");
    const payload = await response.json() as { plans: Plan[] };
    setPlans(payload.plans);
    setPlansLoaded(true);
  }, [sessionMeta, workspace.context.semesterId]);

  const loadInactiveCandidates = useCallback(async () => {
    if (!sessionMeta || (type !== "stage_trend" && type !== "course_end")) {
      setInactiveCandidates([]);
      return;
    }
    const query = new URLSearchParams({ scope: "all", semesterId: workspace.context.semesterId });
    const response = await fetch(`/api/students?${query.toString()}`);
    if (!response.ok) throw new Error("无法读取停读学生名单");
    const students = await response.json() as RosterCandidate[];
    setInactiveCandidates(students.filter((student) => student.classId === sessionMeta.classId && student.rosterStatus === "INACTIVE"));
  }, [sessionMeta, type, workspace.context.semesterId]);

  const loadRangeSessions = useCallback(async () => {
    if (!workspace.context.semesterId || !workspace.context.className) return;
    const query = new URLSearchParams({ semesterId: workspace.context.semesterId, className: workspace.context.className });
    const response = await fetch(`/api/sessions?${query.toString()}`);
    if (!response.ok) throw new Error("无法读取阶段范围课次");
    const payload = await response.json() as Array<{ id: string; code: string; date: string; semesterNumber: number }>;
    setRangeSessions(payload);
  }, [workspace.context.className, workspace.context.semesterId]);

  const loadRangeContext = useCallback(async () => {
    if (!sessionMeta || (type !== "stage_trend" && type !== "course_end") || rangeSessions.length === 0) {
      setRangeContextStudents([]);
      return;
    }
    const end = rangeSessions.find((session) => session.id === (rangeEndSessionId || sessionMeta.sessionId));
    const eligible = rangeSessions.filter((session) => !end || session.date < end.date || (session.date === end.date && session.semesterNumber <= end.semesterNumber));
    const selectedRange = rangeStartSessionId
      ? eligible.slice(Math.max(0, eligible.findIndex((session) => session.id === rangeStartSessionId)))
      : type === "stage_trend" ? eligible.slice(-4) : eligible;
    const sessionIds = selectedRange.map((session) => session.id);
    if (!sessionIds.length) return;
    const query = new URLSearchParams({ semesterId: workspace.context.semesterId, sessionCode: workspace.context.sessionCode, sessionIds: sessionIds.join(",") });
    const response = await fetch(`/api/report/feedback-context?${query.toString()}`);
    if (!response.ok) throw new Error("无法读取阶段范围候选学生");
    const payload = await response.json() as { students?: FeedbackContextStudent[] };
    setRangeContextStudents(payload.students ?? []);
  }, [rangeEndSessionId, rangeSessions, rangeStartSessionId, sessionMeta, type, workspace.context.semesterId, workspace.context.sessionCode]);

  useEffect(() => {
    setSessionMeta(null);
    setActivePlan(null);
    setPlanLoading(Boolean(requestedPlanId));
    setPlans([]);
    setPlansLoaded(false);
    setInactiveCandidates([]);
    setStudentOverrides({});
    setIndependentStudentTarget(null);
    setIndependentItemTarget(null);
    setSelectedItemIds([]);
    setRepeatExportRequest(null);
    setContextMetaError("");
    candidateDefaultsKey.current = "";
  }, [requestedPlanId, workspace.context.semesterId, workspace.context.sessionCode]);
  useEffect(() => {
    if (!workspace.context.semesterId || !workspace.context.sessionCode) return;
    let cancelled = false;
    setContextMetaError("");
    void fetch(`/api/report/feedback-context?sessionCode=${encodeURIComponent(workspace.context.sessionCode)}&semesterId=${encodeURIComponent(workspace.context.semesterId)}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as ({ session?: { id: string; classId: string } } & ApiFailurePayload) | null;
        if (!response.ok) throw new Error(apiFailureMessage(payload, `请求失败（HTTP ${response.status}）`));
        if (!payload?.session) throw new Error("当前课次缺少班级信息");
        return payload.session;
      })
      .then((session) => {
        if (cancelled) return;
        setSessionMeta({ classId: session.classId, sessionId: session.id });
        setContextMetaError("");
      })
      .catch((reason) => {
        if (!cancelled) setContextMetaError(reason instanceof Error ? reason.message : "未知错误");
      });
    return () => { cancelled = true; };
  }, [contextMetaReloadKey, workspace.context.semesterId, workspace.context.sessionCode]);
  useEffect(() => {
    if (!sessionMeta) return;
    void loadPlans().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取反馈计划"));
  }, [loadPlans, sessionMeta]);
  useEffect(() => {
    if (workspace.activeStep === "prepare") return;
    if (requestedPlanId && activePlan?.id === requestedPlanId) return;
    if (!requestedPlanId && activePlan) return;
    if (workspace.activeStep === "review" && !requestedPlanId) return;
    if (!requestedPlanId && (!sessionMeta || !plansLoaded)) return;
    const candidateId = requestedPlanId ?? plans.find((plan) => (
      plan.sessionId === sessionMeta?.sessionId
      || plan.rangeEndSessionId === sessionMeta?.sessionId
    ))?.id;
    if (!candidateId) {
      setPlanLoading(false);
      return;
    }
    if (activePlan && activePlan.id !== candidateId) setActivePlan(null);
    let cancelled = false;
    setPlanLoading(true);
    void fetch(`/api/report/feedback-plans/${candidateId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("无法恢复当前课次的反馈计划");
        return response.json() as Promise<{ plan: Plan }>;
      })
      .then((payload) => { if (!cancelled) setActivePlan(payload.plan); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法恢复反馈计划"); })
      .finally(() => { if (!cancelled) setPlanLoading(false); });
    return () => { cancelled = true; };
  }, [activePlan, plans, plansLoaded, requestedPlanId, sessionMeta, workspace.activeStep]);
  useEffect(() => {
    void loadInactiveCandidates().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取停读学生名单"));
  }, [loadInactiveCandidates]);
  useEffect(() => {
    void loadRangeSessions().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取阶段范围课次"));
  }, [loadRangeSessions]);
  useEffect(() => {
    void loadRangeContext().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取阶段范围候选学生"));
  }, [loadRangeContext]);
  useEffect(() => {
    setRangeEndSessionId(sessionMeta?.sessionId ?? "");
  }, [sessionMeta?.sessionId]);
  useEffect(() => {
    const key = [
      workspace.context.sessionCode,
      type,
      rangeStartSessionId,
      rangeEndSessionId,
      candidateStudents.map((student) => student.id).join(","),
      recommendedStudents.map((student) => student.id).join(","),
    ].join(":");
    if (candidateDefaultsKey.current === key) return;
    candidateDefaultsKey.current = key;
    const defaultIds = type === "event_micro"
      ? [...new Set([...recommendedStudents.map((student) => student.id), ...confirmedAssessmentStudentIds])]
      : candidateStudents.map((student) => student.id);
    setSelectedStudentIds(defaultIds);
  }, [candidateStudents, confirmedAssessmentStudentIds, rangeEndSessionId, rangeStartSessionId, recommendedStudents, type, workspace.context.sessionCode]);
  useEffect(() => {
    if (!activePlan) return;
    setDrafts((current) => syncFeedbackItemDrafts(current, activePlan.items.map((item) => ({
      id: item.id,
      text: item.finalText ?? parseComposition(item.compositionSnapshot, activePlan.type, item.composition).draftFeedback ?? "",
      revision: item.itemRevision,
    }))));
    setSelectedItemIds((current) => {
      const selectable = new Set(activePlan.items
        .filter((item) => !["approved", "exported", "stale", "generating", "queued", "pause_requested"].includes(item.status))
        .map((item) => item.id));
      return current.length ? current.filter((id) => selectable.has(id)) : [...selectable];
    });
  }, [activePlan]);

  const activePlanId = activePlan?.id;
  const activePlanGenerationActive = feedbackPlanGenerationIsActive(activePlan);
  useEffect(() => {
    if (!activePlanId || !activePlanGenerationActive) return;
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const sequence = ++activePlanPollSequence.current;

    const poll = async () => {
      const responseSequence = ++activePlanResponseSequence.current;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/report/feedback-plans/${activePlanId}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("无法刷新反馈计划状态");
        const payload = await response.json() as { plan: Plan };
        if (!cancelled
          && sequence === activePlanPollSequence.current
          && responseSequence === activePlanResponseSequence.current
          && payload.plan.id === activePlanId) {
          setActivePlan(payload.plan);
        }
      } catch {
        // 轮询失败不覆盖当前可用快照；下一轮继续向服务端取权威状态。
      } finally {
        if (!cancelled && sequence === activePlanPollSequence.current) {
          timer = window.setTimeout(() => void poll(), 800);
        }
      }
    };

    timer = window.setTimeout(() => void poll(), 800);
    return () => {
      cancelled = true;
      activePlanPollSequence.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [activePlanGenerationActive, activePlanId]);

  async function createPlan() {
    if (!sessionMeta) return;
    if (workspace.draftId && !workspace.confirmed) {
      setError("当前结构化记录还没有写入。请先点击“确认写入”，再创建反馈计划，避免计划遗漏刚才的复核修改。");
      return;
    }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/report/feedback-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          outputRequirement,
          generationApproach,
          semesterId: workspace.context.semesterId,
          classId: sessionMeta.classId,
          sessionId: sessionMeta.sessionId,
          rangeStartSessionId: type === "stage_trend" || type === "course_end" ? (rangeStartSessionId || undefined) : undefined,
          rangeEndSessionId: type === "stage_trend" || type === "course_end" ? (rangeEndSessionId || sessionMeta.sessionId) : sessionMeta.sessionId,
          ...(type === "class_update" ? {} : { studentIds: selectedStudentIds }),
          ...(type === "class_update" ? {} : { assessmentEvidence: assessmentEvidenceForStudentIds(selectedStudentIds) }),
          ...(type === "class_update" ? {} : {
            studentOverrides: Object.entries(studentOverrides)
              .filter(([studentId]) => selectedStudentIds.includes(studentId))
              .map(([studentId, generationConfig]) => ({ studentId, generationConfig })),
          }),
          lessonMaterial: workspace.lessonMaterial,
          generationPreferences: {
            closureType: generationClosureType,
            moduleKeys: generationModuleKeys,
          },
        }),
      });
      const payload = await response.json() as { plan?: Plan } & ApiFailurePayload;
      if (!response.ok || !payload.plan) throw new Error(apiFailureMessage(payload, "创建反馈计划失败"));
      await openPlan(payload.plan.id);
      workspace.setActiveStep("generate");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建反馈计划失败"); }
    finally { setBusy(false); }
  }

  async function generatePlan(plan: Plan) {
    if (feedbackPlanUsesRetiredLegacyGeneration(plan)) {
      setError("旧生成方式已退役，不能启动新的模型调用。已有正文仍可复核、批准和导出；如需重新生成，请另存为受限反馈或自由反馈计划。");
      return;
    }
    if (planHasGenerationTrace(plan)) {
      setError("本计划已经启动过生成，内容和生成设置已冻结。请回到“规划”建立修正计划；失败条目请使用重试。");
      return;
    }
    const itemIds = plan.items
      .filter((item) => selectedItemIds.includes(item.id) && canRegenerate(item))
      .map((item) => item.id);
    if (!itemIds.length) {
      setError("请先勾选尚未开始生成的条目。");
      return;
    }
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          action: "start_generation",
          itemIds,
          ...(plan.generationApproach === "restricted" || plan.generationApproach === "free"
            ? { generationApproach: plan.generationApproach }
            : {}),
          ...(plan.planRevision ? { expectedPlanRevision: plan.planRevision } : {}),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
        throw new Error(apiFailureMessage(payload, "生成反馈计划失败"));
      }
      await openPlan(plan.id);
      workspace.setActiveStep("generate");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生成反馈计划失败");
      await openPlan(plan.id).catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function retainStaleText(plan: Plan) {
    const itemIds = plan.items.filter((item) => item.status === "stale" && item.finalText?.trim()).map((item) => item.id);
    if (!itemIds.length) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retain_stale", itemIds }),
      });
      const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "保留现有反馈失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保留现有反馈失败"); }
    finally { setBusy(false); }
  }

  async function openPlan(id: string): Promise<Plan> {
    const responseSequence = ++activePlanResponseSequence.current;
    const response = await fetch(`/api/report/feedback-plans/${id}`);
    if (!response.ok) throw new Error("无法读取反馈计划详情");
    const payload = await response.json() as { plan: Plan };
    if (responseSequence === activePlanResponseSequence.current) setActivePlan(payload.plan);
    await loadPlans();
    return payload.plan;
  }

  function startNewPlan() {
    const url = new URL(window.location.href);
    url.searchParams.delete("planId");
    window.history.replaceState({}, "", url);
    setActivePlan(null);
    setSelectedItemIds([]);
    setDrafts({});
    setTaskDrafts({});
    setRepeatExportRequest(null);
    setError("");
    candidateDefaultsKey.current = "";
  }

  function openPlanRevision() {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "plan");
    window.location.assign(`${url.pathname}?${url.searchParams.toString()}${url.hash}`);
  }

  async function resolvePreferenceCandidate(item: PlanItem, candidateId: string, decision: "confirmed" | "rejected") {
    if (!item.studentId) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/students/${encodeURIComponent(item.studentId)}/communication-preference/candidates/${encodeURIComponent(candidateId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "处理沟通偏好候选失败"));
      if (activePlan) await openPlan(activePlan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "处理沟通偏好候选失败"); }
    finally { setBusy(false); }
  }

  const saveItem = useCallback(async (item: PlanItem) => {
    if (!activePlan) return;
    const draft = drafts[item.id];
    if (!draft) return;
    const planId = activePlan.id;
    setSavingItemIds((current) => [...new Set([...current, item.id])]);
    setError("");
    try {
      const savedItem = await persistFeedbackItemDraft(planId, item, draft);
      setActivePlan((current) => current?.id === planId
        ? {
          ...current,
          status: "in_review",
          items: current.items.map((currentItem) => currentItem.id === item.id ? { ...currentItem, ...savedItem } : currentItem),
        }
        : current);
      setPlans((current) => current.map((plan) => plan.id === planId ? { ...plan, status: "in_review" } : plan));
      setDrafts((current) => {
        const latest = current[item.id];
        return {
          ...current,
          [item.id]: latest && latest.text !== draft.text
            ? { ...latest, revision: savedItem.itemRevision }
            : { text: savedItem.finalText ?? "", revision: savedItem.itemRevision },
        };
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存反馈失败"); }
    finally { setSavingItemIds((current) => current.filter((id) => id !== item.id)); }
  }, [activePlan, drafts]);

  useEffect(() => {
    if (!activePlan || busy || activePlan.archivedAt) return;
    const saving = new Set(savingItemIds);
    const dirtyItems = activePlan.items.filter((item) => {
      const draft = drafts[item.id];
      const attemptKey = draft ? `${draft.revision}\u0000${draft.text}` : "";
      return feedbackPlanItemShouldAutoSave(item, draft, saving.has(item.id), Boolean(activePlan.archivedAt))
        && autoSaveAttempts.current[item.id] !== attemptKey;
    });
    if (!dirtyItems.length) return;
    const timer = window.setTimeout(() => dirtyItems.forEach((item) => {
      const draft = drafts[item.id];
      if (draft) autoSaveAttempts.current[item.id] = `${draft.revision}\u0000${draft.text}`;
      void saveItem(item);
    }), 800);
    return () => window.clearTimeout(timer);
  }, [activePlan, busy, drafts, saveItem, savingItemIds]);

  function openIndependentItem(item: PlanItem) {
    if (!item.studentId || !item.student) return;
    setIndependentItemTarget({ item, studentName: item.student.name });
  }

  async function saveIndependentItem(config: FeedbackPlanItemGenerationConfig | null) {
    if (!activePlan || !independentItemTarget) return;
    if (planHasGenerationTrace(activePlan)) {
      setError("已经启动生成的计划不能原位修改学生设置，请回到“规划”建立修正计划。");
      return;
    }
    const item = independentItemTarget.item;
    if (item.finalText?.trim() && item.reviewMode !== "teacher_edited") {
      const confirmed = window.confirm("修改独立计划会清除这位学生当前未批准的模型草稿，并需要重新生成。是否继续？");
      if (!confirmed) return;
    }
    const response = await fetch(`/api/report/feedback-plans/${activePlan.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "item", itemId: item.id, patch: { generationConfig: config, expectedItemRevision: item.itemRevision } }),
    });
    const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
    if (!response.ok) throw new Error(apiFailureMessage(payload, "保存学生独立计划失败"));
    await openPlan(activePlan.id);
    setIndependentItemTarget(null);
  }

  async function pausePlan(plan: Plan) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause_generation" }),
      });
      const payload = await response.json() as ApiFailurePayload & { plan?: Plan };
      if (!response.ok) throw new Error(apiFailureMessage(payload, "暂停生成失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "暂停生成失败"); }
    finally { setBusy(false); }
  }

  async function forceStopPlan(plan: Plan) {
    if (!window.confirm("强制终止会立即停止调度并请求中断当前模型调用；已完成的反馈会保留，中断条目将转为失败并可重试。确定继续吗？")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "force_stop_generation" }),
      });
      const payload = await response.json() as ApiFailurePayload & { plan?: Plan };
      if (!response.ok) throw new Error(apiFailureMessage(payload, "强制终止生成失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "强制终止生成失败"); }
    finally { setBusy(false); }
  }

  async function continuePlan(plan: Plan) {
    if (feedbackPlanUsesRetiredLegacyGeneration(plan)) {
      setError("旧生成方式已退役，不能继续生成。请另存为受限反馈或自由反馈计划；原计划正文和历史记录保持不变。");
      return;
    }
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "continue_generation" }),
      });
      const payload = await response.json() as ApiFailurePayload & { plan?: Plan };
      if (!response.ok) throw new Error(apiFailureMessage(payload, "继续生成失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "继续生成失败"); }
    finally { setBusy(false); }
  }

  async function retryPlan(plan: Plan, explicitItemIds?: string[]) {
    if (feedbackPlanGenerationIsActive(plan)) {
      setError("当前仍有反馈正在生成，请先等待完成或强制终止后再重试。");
      return;
    }
    if (feedbackPlanUsesRetiredLegacyGeneration(plan)) {
      setError("旧生成方式已退役，不能重试生成。请另存为受限反馈或自由反馈计划；已有正文仍可继续复核。");
      return;
    }
    const failedIds = explicitItemIds ?? plan.items.filter((item) => item.status === "generation_failed").map((item) => item.id);
    if (!failedIds.length) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry_generation", itemIds: failedIds }),
      });
      const payload = await response.json() as ApiFailurePayload & { plan?: Plan };
      if (!response.ok) throw new Error(apiFailureMessage(payload, "重试失败反馈失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "重试失败反馈失败"); }
    finally { setBusy(false); }
  }

  async function retryPlanWithFree(plan: Plan, explicitItemIds?: string[]) {
    if (feedbackPlanGenerationIsActive(plan)) {
      setError("当前仍有反馈正在生成，请先等待完成或强制终止后再改用自由反馈。");
      return;
    }
    const failedIds = explicitItemIds ?? plan.items.filter((item) => item.status === "generation_failed").map((item) => item.id);
    if (!failedIds.length || plan.generationApproach !== "restricted") return;
    if (!window.confirm(`将 ${failedIds.length} 个失败条目改用自由反馈重试？\n\n已成功的结果不会改变；这些失败条目会改为单阶段生成，并继续执行程序核验。`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry_with_free", itemIds: failedIds }),
      });
      const payload = await response.json() as ApiFailurePayload & { plan?: Plan };
      if (!response.ok) throw new Error(apiFailureMessage(payload, "改用自由反馈失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "改用自由反馈失败"); }
    finally { setBusy(false); }
  }

  async function approvePlan(plan: Plan, explicitItemIds?: string[]) {
    const approvalIds = explicitItemIds ?? selectedItemIds;
    const dirtySelected = plan.items.filter((item) => {
      const draft = drafts[item.id];
      return approvalIds.includes(item.id) && draft && draft.text !== (item.finalText ?? "");
    });
    if (dirtySelected.length) {
      setError(`请先保存所选反馈中的未保存修改：${dirtySelected.map((item) => item.student?.name ?? "班级公共反馈").join("、")}`);
      return;
    }
    setBusy(true); setError("");
    try {
      const approvable = plan.items.filter((item) => (
        approvalIds.includes(item.id)
        && !["approved", "exported", "stale", "generating"].includes(item.status)
        && Boolean(item.finalText?.trim())
        && auditStatus(item) !== "blocked"
      ));
      if (!approvable.length) {
        const selected = plan.items.filter((item) => approvalIds.includes(item.id));
        const failures = selected.map((item) => {
          const name = item.student?.name ?? "班级公共反馈";
          if (!item.finalText?.trim()) return `${name}：尚无最终文本`;
          if (["stale", "generating"].includes(item.status)) return `${name}：${planStatusLabel(item.status)}`;
          if (auditStatus(item) === "blocked") return `${name}：存在必须先修改的程序核验问题`;
          return `${name}：当前状态不能批准`;
        });
        throw new Error(failures.length ? failures.join("；") : "请先选择要批准的反馈条目。");
      }
      const expectedHashes = Object.fromEntries(approvable.map((item) => [item.id, item.finalTextHash || ""]));
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve", itemIds: approvable.map((item) => item.id), expectedHashes }),
      });
      const payload = await response.json() as ApiFailurePayload;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "批准反馈失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "批准反馈失败"); }
    finally { setBusy(false); }
  }

  async function createTask(plan: Plan, item: PlanItem) {
    const composition = parseObject(item.compositionSnapshot);
    const followup = (composition.modules || []).find((module: { key: string; content?: string }) => module.key === "followup_observation" || module.key === "teacher_support");
    const anchorId = plan.rangeEndSessionId || plan.sessionId;
    const anchorIndex = rangeSessions.findIndex((session) => session.id === anchorId);
    const nextSession = anchorIndex >= 0 ? rangeSessions[anchorIndex + 1] : undefined;
    const draft = taskDrafts[item.id] ?? {
      action: followup?.content || "在后续课次观察该问题是否稳定改善",
      dueType: nextSession ? "session" as const : "date" as const,
      dueSessionId: nextSession?.id ?? "",
      dueDate: "",
    };
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "task",
          itemId: item.id,
          taskAction: draft.action,
          dueType: draft.dueType,
          dueSessionId: draft.dueType === "session" ? draft.dueSessionId || undefined : undefined,
          dueDate: draft.dueType === "date" ? draft.dueDate : undefined,
          estimatedMinutes: 3,
          promiseExcerpt: followup?.content || draft.action,
        }),
      });
      const payload = await response.json() as ApiFailurePayload;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "创建教师任务失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建教师任务失败"); }
    finally { setBusy(false); }
  }

  async function uploadAttachment(plan: Plan, item: PlanItem, file: File | undefined) {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const form = new FormData(); form.set("file", file); form.set("itemId", item.id);
      const response = await fetch(`/api/report/feedback-plans/${plan.id}/attachments`, { method: "POST", body: form });
      const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "保存附件失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存附件失败"); }
    finally { setBusy(false); }
  }

  async function removeAttachment(plan: Plan, attachmentId: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}/attachments`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentId }),
      });
      const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "删除附件失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除附件失败"); }
    finally { setBusy(false); }
  }

  async function exportPlan(plan: Plan, mode: "complete" | "approved_only", allowRepeat = false) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "export", mode, allowRepeat }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
        if (apiFailureCode(payload) === "repeat_export") setRepeatExportRequest({ planId: plan.id, mode });
        throw new Error(apiFailureMessage(payload, "反馈计划导出失败"));
      }
      const blob = await response.blob();
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") || blob.size < 512) {
        throw new Error("导出响应不是有效的 Excel 文件，请重试或查看服务日志");
      }
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = href; anchor.download = `feedback-plan_${plan.id}.xlsx`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(href);
      setRepeatExportRequest(null);
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "反馈计划导出失败"); }
    finally { setBusy(false); }
  }

  async function exportWeComDrafts(plan: Plan) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export_wecom_drafts" }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
        throw new Error(apiFailureMessage(payload, "企微草稿包导出失败"));
      }
      const blob = await response.blob();
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json") || blob.size < 128) throw new Error("导出响应不是有效的企微草稿 JSON");
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = href; anchor.download = `wecom-drafts_${plan.id}.json`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(href);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "企微草稿包导出失败"); }
    finally { setBusy(false); }
  }

  async function deletePlan(plan: Plan) {
    if (!window.confirm(`确认删除“${typeLabels[plan.type]}”计划及其受控附件吗？此操作不可撤销。`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "删除反馈计划失败"));
      setActivePlan(null);
      await loadPlans();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除反馈计划失败"); }
    finally { setBusy(false); }
  }

  async function archivePlan(plan: Plan) {
    if (!window.confirm(`确认归档“${typeLabels[plan.type]}”计划吗？归档后默认不显示，但仍可在反馈历史中恢复。`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "archive" }),
      });
      const payload = await response.json() as ApiFailurePayload;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "归档反馈计划失败"));
      setActivePlan(null);
      await loadPlans();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "归档反馈计划失败"); }
    finally { setBusy(false); }
  }

  const studioMatches = useCallback((item: PlanItem, filter: typeof studioFilter) => {
    if (filter === "all") return true;
    if (filter === "done") return ["approved", "exported"].includes(item.status);
    if (filter === "review") return item.status === "needs_review";
    return ["evidence_ready", "queued", "generating", "generation_failed", "stale", "pause_requested", "paused"].includes(item.status)
      || !["needs_review", "approved", "exported"].includes(item.status);
  }, []);

  useEffect(() => {
    if (presentation !== "studio" || !activePlan?.items.length) return;
    const visible = activePlan.items.filter((item) => studioMatches(item, studioFilter));
    if (!visible.some((item) => item.id === studioItemId)) setStudioItemId((visible[0] ?? activePlan.items[0]).id);
  }, [activePlan, presentation, studioFilter, studioItemId, studioMatches]);

  useEffect(() => {
    if (presentation !== "studio" || !focusItemId || !activePlan?.items.length) return;
    const target = activePlan.items.find((item) => item.id === focusItemId);
    if (!target) return;
    const targetFilter = ["approved", "exported"].includes(target.status)
      ? "done"
      : target.status === "needs_review" ? "review" : "action";
    setStudioFilter(targetFilter);
    setStudioItemId(target.id);
  }, [activePlan, focusItemId, presentation]);

  if (!showPanel) return null;
  const isReview = workspace.activeStep === "review";
  const isGenerate = workspace.activeStep === "generate";
  const isExport = workspace.activeStep === "export";
  const studioMode = presentation === "studio" && isExport;
  const batchMode = Boolean(batchControl?.active);
  const title = isReview ? "复核与反馈计划" : isGenerate ? "生成反馈" : studioMode ? "逐学生计划工作室" : "编辑与导出";
  const description = isReview
    ? "先确认结构化课堂记录，再填写一次总体反馈要求和对象；点击生成后进入可恢复的队列。"
    : isGenerate
      ? "生成状态写入反馈计划，页面刷新或断线不会丢失已完成结果。最多同时处理 2 条。"
    : isExport
      ? studioMode ? "一次只聚焦一名学生；左侧切换对象，右侧完成生成、证据复核、正文编辑、独立设置与批准。" : "只把已批准的教师最终文本写入 Excel；未批准条目不会进入导出。"
      : "默认展示学生、历史趋势、证据摘要、模型建议、家庭偏好和可编辑正文；其余内容在高级区域。";
  const legacyGenerationRetired = Boolean(activePlan && feedbackPlanUsesRetiredLegacyGeneration(activePlan));
  const canGenerate = Boolean(activePlan && !legacyGenerationRetired && !planHasGenerationTrace(activePlan) && activePlan.items.some((item) => selectedItemIds.includes(item.id) && canRegenerate(item)));
  const staleTextCount = activePlan?.items.filter((item) => item.status === "stale" && item.finalText?.trim()).length ?? 0;
  const allItemsApproved = Boolean(activePlan?.items.length && activePlan.items.every((item) => ["approved", "exported"].includes(item.status)));
  const archivedReadOnly = Boolean(activePlan?.archivedAt);
  const llmReady = !llmWorkspace.loading && Boolean(llmWorkspace.form.apiKey?.trim() && llmWorkspace.form.model?.trim());
  const studioItems = activePlan?.items.filter((item) => studioMatches(item, studioFilter)) ?? [];
  const visiblePlanItems = studioMode && studioItemId
    ? activePlan?.items.filter((item) => item.id === studioItemId) ?? []
    : activePlan?.items ?? [];
  const studioGenerationCounts = activePlan ? {
    completed: activePlan.generationProgress?.completed ?? activePlan.items.filter((item) => ["needs_review", "approved", "exported"].includes(item.status)).length,
    queued: activePlan.generationProgress?.queued ?? activePlan.items.filter((item) => item.status === "queued").length,
    running: activePlan.generationProgress?.running ?? activePlan.items.filter((item) => item.status === "generating").length,
    failed: activePlan.generationProgress?.failed ?? activePlan.items.filter((item) => item.status === "generation_failed").length,
  } : null;
  const generationActive = feedbackPlanGenerationIsActive(activePlan);

  const hasUnconfirmedDraft = Boolean(workspace.draftId && !workspace.confirmed);

  const publicGenerationConfig = commonGenerationConfig(type, outputRequirement, {
    closureType: generationClosureType,
    moduleKeys: generationModuleKeys,
  });
  const independentStudentConfig = independentStudentTarget
    ? independentConfigFromCommon(publicGenerationConfig, studentOverrides[independentStudentTarget.id] ?? null)
    : publicGenerationConfig;
  const independentItemConfig = independentItemTarget && activePlan
    ? independentConfigFromCommon(
      commonGenerationConfig(activePlan.type, activePlan.outputRequirement, activePlan.input?.generationPreferences),
      independentItemTarget.item.generationConfig,
    )
    : publicGenerationConfig;

  const sectionActions = isReview
    ? <div className="feedback-plan-header-actions">
      {activePlan && <Button uiSize="sm" variant="secondary" onClick={startNewPlan} disabled={busy}>新建反馈计划</Button>}
      <Button onClick={() => activePlan ? workspace.setActiveStep("generate") : void createPlan()} disabled={busy || (!activePlan && (hasUnconfirmedDraft || !sessionMeta || !outputRequirement.trim() || (type !== "class_update" && selectedStudentIds.length === 0)))}>{busy ? "处理中…" : activePlan ? "前往生成" : "进入生成"}</Button>
      {activePlan && !archivedReadOnly && activePlan.status === "draft" && <Button uiSize="sm" variant="ghost" onClick={() => void deletePlan(activePlan)} disabled={busy}>删除草稿</Button>}
    </div>
    : activePlan ? <div className="feedback-plan-header-actions">
      <div className="feedback-plan-current-actions" aria-label="当前计划操作">
        {!batchMode && (isGenerate || studioMode) && generationActive && <Button uiSize="sm" variant="secondary" onClick={() => void pausePlan(activePlan)} disabled={busy || archivedReadOnly || activePlan.status === "pause_requested"}>{activePlan.status === "pause_requested" ? "正在安全暂停…" : "暂停生成"}</Button>}
        {!batchMode && (isGenerate || studioMode) && generationActive && <Button uiSize="sm" variant="danger" onClick={() => void forceStopPlan(activePlan)} disabled={busy || archivedReadOnly}>强制终止</Button>}
        {!batchMode && (isGenerate || studioMode) && activePlan.status === "paused" && !legacyGenerationRetired && <Button uiSize="sm" variant="secondary" onClick={() => void continuePlan(activePlan)} disabled={busy || archivedReadOnly}>继续生成</Button>}
        {!batchMode && isGenerate && activePlan.status === "generation_failed" && !legacyGenerationRetired && <Button uiSize="sm" variant="secondary" onClick={() => void retryPlan(activePlan)} disabled={busy || archivedReadOnly || generationActive}>重试失败条目</Button>}
        {legacyGenerationRetired && (isGenerate || studioMode) && !["queued", "generating", "pause_requested"].includes(activePlan.status) && <Button uiSize="sm" variant="secondary" onClick={openPlanRevision} disabled={busy}>另存为受限/自由计划</Button>}
        {isExport && staleTextCount > 0 && <Button uiSize="sm" variant="secondary" onClick={() => void retainStaleText(activePlan)} disabled={busy || archivedReadOnly}>保留现有正文（{staleTextCount}）</Button>}
        {isExport && !legacyGenerationRetired && studioMode && !batchMode && activePlan.items.some((item) => item.status === "generation_failed") && <Button uiSize="sm" variant="secondary" onClick={() => void retryPlan(activePlan)} disabled={busy || archivedReadOnly || !llmReady || generationActive}>重试全部失败项</Button>}
        {isExport && !allItemsApproved && <Button uiSize="sm" onClick={() => void approvePlan(activePlan)} disabled={busy || archivedReadOnly || selectedItemIds.length === 0}>批准所选可通过项</Button>}
      </div>
      {isExport && <div className="feedback-plan-tool-actions" role="toolbar" aria-label="计划工具栏">
        <Button uiSize="sm" variant="secondary" onClick={() => void exportPlan(activePlan, "complete")} disabled={busy || !allItemsApproved}>完整导出</Button>
        <Button uiSize="sm" variant="secondary" onClick={() => void exportPlan(activePlan, "approved_only")} disabled={busy || !activePlan.items.some((item) => item.status === "approved")}>仅导出新批准项</Button>
        {capabilities.wecomDraftExport && <Button uiSize="sm" variant="secondary" onClick={() => void exportWeComDrafts(activePlan)} disabled={busy || !activePlan.items.some((item) => item.studentId && ["approved", "exported"].includes(item.status) && item.finalText?.trim())}>导出企微草稿 JSON</Button>}
        {!archivedReadOnly && <Button uiSize="sm" variant="ghost" onClick={() => void archivePlan(activePlan)} disabled={busy}>归档计划</Button>}
      </div>}
    </div> : null;

  return <Section title={title} description={description} className="feedback-plan-panel" actions={sectionActions}>

    {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    {isReview && !activePlan && hasUnconfirmedDraft && <StatusBanner tone="warning">当前结构化记录尚未写入，生成入口已锁定。请先在上方完成“确认写入”；之后候选学生和证据会自动刷新。</StatusBanner>}
    {contextMetaError && <StatusBanner tone="danger"><span>当前课次信息读取失败：{contextMetaError}</span><Button uiSize="sm" variant="secondary" onClick={() => setContextMetaReloadKey((key) => key + 1)}>重试读取课次</Button></StatusBanner>}
    {archivedReadOnly && <StatusBanner tone="warning">已归档，只读；请在反馈历史中取消归档后修改。</StatusBanner>}
    {!isReview && !activePlan && (planLoading || !plansLoaded) && <StatusBanner tone="info">正在读取反馈计划…</StatusBanner>}
    {!isReview && !activePlan && !planLoading && plansLoaded && !requestedPlanId && <StatusBanner tone="warning"><span>当前课次还没有可恢复的反馈计划，请先回到“复核”步骤创建计划。</span><Button uiSize="sm" variant="secondary" onClick={() => workspace.setActiveStep("review")}>返回复核</Button></StatusBanner>}
    {repeatExportRequest && activePlan?.id === repeatExportRequest.planId && <StatusBanner tone="warning"><span>相同文本已经导出过。只有确实需要重新下载时才继续。</span><Button uiSize="sm" variant="secondary" onClick={() => void exportPlan(activePlan, repeatExportRequest.mode, true)} disabled={busy}>确认重复导出</Button><Button uiSize="sm" variant="ghost" onClick={() => setRepeatExportRequest(null)} disabled={busy}>取消</Button></StatusBanner>}
    {studioMode && !legacyGenerationRetired && !llmWorkspace.loading && !llmReady && <StatusBanner tone="danger"><span>当前没有可用的 LLM API Key 或模型。已有正文仍可编辑；生成和重试暂时锁定。</span><Link href="/system/configuration">前往系统中心配置</Link></StatusBanner>}
    {studioMode && activePlan && !legacyGenerationRetired && <details className="feedback-plan-studio-models"><summary>模型角色与生成设置</summary><LLMRoleAssignmentsPanel workspace={llmWorkspace} showWecom={false} /></details>}
    {studioMode && activePlan && studioGenerationCounts && ["queued", "generating", "pause_requested", "paused", "generation_failed"].includes(activePlan.status) && <div className="feedback-plan-studio-generation" role="status" aria-label="反馈生成进度">
      <div><span className={`feedback-plan-studio-generation__signal is-${activePlan.status}`} aria-hidden="true" /><span><strong>{planStatusLabel(activePlan.status)}</strong><small>{activePlan.status === "pause_requested" ? "正在等待当前生成中的条目安全结束" : activePlan.status === "paused" ? "队列已停止，不会启动新的学生" : "生成进度会自动保存，离开页面也不会丢失"}</small></span></div>
      <progress max={activePlan.items.length || 1} value={studioGenerationCounts.completed + studioGenerationCounts.failed}>{studioGenerationCounts.completed + studioGenerationCounts.failed}/{activePlan.items.length}</progress>
      <div className="feedback-plan-studio-generation__counts"><span>完成 <b>{studioGenerationCounts.completed}</b></span><span>生成中 <b>{studioGenerationCounts.running}</b></span><span>排队 <b>{studioGenerationCounts.queued}</b></span>{studioGenerationCounts.failed > 0 && <span className="is-danger">失败 <b>{studioGenerationCounts.failed}</b></span>}</div>
    </div>}
    {isReview && !activePlan && <div className="feedback-plan-create">
      <div className="feedback-plan-form-grid">
        <label><span>反馈类型</span><select aria-label="反馈类型" value={type} onChange={(event) => changePlanType(event.target.value as FeedbackPlanType)}>{Object.entries(typeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label><span>生成方式</span><select aria-label="反馈生成方式" value={generationApproach} onChange={(event) => setGenerationApproach(event.target.value as FeedbackGenerationApproach)}><option value="restricted">受限反馈</option><option value="free">自由反馈</option></select><small>{generationApproachDescription(generationApproach)}</small></label>
        <label><span>反馈要求与补充事实</span><textarea rows={3} value={outputRequirement} onChange={(event) => setOutputRequirement(event.target.value)} placeholder="告诉模型这次怎么写，也可以补充或纠正事实；老师在这里写出的事实会直接视为已确认。" /></label>
      </div>
      <fieldset className="feedback-plan-generation-preferences">
        <legend>生成阶段结构</legend>
        <p>结尾类型和可选模块在创建计划时确定，并写入计划快照；生成与审核会遵守这里的选择，导出阶段只负责使用已批准正文。不选择模块时，按当前反馈类型自然组织，不会因数量阻断。</p>
        <div className="feedback-plan-form-grid">
          <label><span>结尾类型</span><select aria-label="生成结尾类型" value={generationClosureType} onChange={(event) => setGenerationClosureType(event.target.value)}>{FEEDBACK_CLOSURES_BY_TYPE[type].map((closure) => <option key={closure} value={closure}>{closureLabels[closure] || closure}</option>)}</select></label>
          <div className="feedback-plan-modules" aria-label="公共计划可选模块"><span className="feedback-plan-label">生成模块（可选）</span>{FEEDBACK_MODULES[type].map((key) => {
            const label = moduleLabels[key] || key;
            const descriptionId = `feedback-public-${key}-description`;
            return <label key={key} className={`feedback-plan-module ${generationModuleKeys.includes(key) ? "is-selected" : ""}`}>
              <input type="checkbox" checked={generationModuleKeys.includes(key)} aria-label={`选择公共模块：${label}`} aria-describedby={descriptionId} onChange={(event) => toggleGenerationModule(key, event.target.checked)} />
              <span><strong>{label}</strong><small id={descriptionId}>{moduleDescriptions[key] || "决定这条反馈关注的内容"}</small></span>
            </label>;
          })}</div>
        </div>
      </fieldset>
      {type !== "class_update" && <fieldset className="feedback-plan-candidates">
        <legend>反馈对象</legend>
        <div className="feedback-plan-candidate-toolbar"><span>{selectedStudentIds.length} 人已选择</span><div><Button uiSize="sm" variant="ghost" onClick={() => setSelectedStudentIds(candidateStudents.map((student) => student.id))}>全选在读</Button><Button uiSize="sm" variant="ghost" onClick={() => setSelectedStudentIds([])}>清空</Button>{type === "event_micro" && <Button uiSize="sm" variant="ghost" onClick={() => setSelectedStudentIds(recommendedStudents.map((student) => student.id))}>仅推荐</Button>}</div></div>
        <div className="feedback-plan-candidate-grid">{candidateStudents.length ? candidateStudents.map((student) => { const recommended = recommendedStudents.some((candidate) => candidate.id === student.id); const hasAssessment = confirmedAssessmentStudentIds.has(student.id); const independent = Boolean(studentOverrides[student.id]); return <div key={student.id} className={`feedback-plan-candidate ${selectedStudentIds.includes(student.id) ? "is-selected" : ""}`}><label><input type="checkbox" checked={selectedStudentIds.includes(student.id)} onChange={(event) => setSelectedStudentIds((ids) => event.target.checked ? [...new Set([...ids, student.id])] : ids.filter((id) => id !== student.id))} /><span><strong>{student.name}</strong><small>{recommended ? student.feedbackRecommendationReasons?.join("、") : hasAssessment ? "已有确认 PDF 证据" : "有确认记录，可手动加入"}</small></span></label><Button type="button" uiSize="sm" variant={independent ? "secondary" : "ghost"} onClick={() => openIndependentStudent({ id: student.id, name: student.name })}>{independent ? "独立计划" : "单独设置"}</Button></div>; }) : <span>当前上下文暂无候选学生</span>}</div>
        {(type === "stage_trend" || type === "course_end") && inactiveCandidates.length > 0 && <details className="feedback-plan-inactive-candidates"><summary>停读学生（仅手动加入）</summary><div className="feedback-plan-candidate-grid">{inactiveCandidates.map((student) => { const independent = Boolean(studentOverrides[student.id]); return <div key={student.id} className={`feedback-plan-candidate ${selectedStudentIds.includes(student.id) ? "is-selected" : ""}`}><label><input type="checkbox" checked={selectedStudentIds.includes(student.id)} onChange={(event) => setSelectedStudentIds((ids) => event.target.checked ? [...new Set([...ids, student.id])] : ids.filter((id) => id !== student.id))} /><span><strong>{student.name}</strong><small>停读 · 手动加入后按历史范围取证</small></span></label><Button type="button" uiSize="sm" variant={independent ? "secondary" : "ghost"} onClick={() => openIndependentStudent({ id: student.id, name: student.name })}>{independent ? "独立计划" : "单独设置"}</Button></div>; })}</div></details>}
      </fieldset>}
      {(type === "stage_trend" || type === "course_end") && <fieldset className="feedback-plan-range"><legend>{type === "stage_trend" ? "阶段范围" : "学期范围"}</legend><p>{type === "stage_trend" ? "首次默认最近四次已完成课次，后续从上一份已批准阶段反馈之后开始。" : "默认覆盖当前学期截至当前课次的全部范围。"}</p><div className="feedback-plan-form-grid"><label><span>起始课次</span><select aria-label="反馈计划起始课次" value={rangeStartSessionId} onChange={(event) => setRangeStartSessionId(event.target.value)}><option value="">自动</option>{rangeSessions.map((session) => <option key={session.id} value={session.id}>{session.code} · {session.date} · 第{session.semesterNumber}次</option>)}</select></label><label><span>截止课次</span><select aria-label="反馈计划截止课次" value={rangeEndSessionId} onChange={(event) => setRangeEndSessionId(event.target.value)}>{rangeSessions.map((session) => <option key={session.id} value={session.id}>{session.code} · {session.date} · 第{session.semesterNumber}次</option>)}</select></label></div></fieldset>}
    </div>}
    {isReview && activePlan && <div className="feedback-plan-existing" role="status"><strong>已恢复反馈计划：{activePlan.displayName?.trim() || typeLabels[activePlan.type]}</strong><span>{typeLabels[activePlan.type]} · {feedbackPlanConfiguredApproachLabel(activePlan)} · {planStatusLabel(activePlan.status)} · {activePlan.items.length} 条目 · {activePlan.outputRequirement}</span><p>{feedbackPlanUsesRetiredLegacyGeneration(activePlan) ? "旧生成方式已经退役；历史配置只读，已有正文仍可复核、批准和导出。需要继续生成时请另存为受限反馈或自由反馈计划。" : "当前计划的课次、课程材料、生成方式和证据快照已固定；点击上方“生成反馈”继续处理，生成中的计划请切换到“生成”查看队列。"}</p></div>}
    {isReview && plans.length > 0 && <div className="feedback-plan-history"><div><strong>计划历史</strong><span>可按名称恢复最近 8 个计划</span></div><div className="feedback-plan-history-list">{plans.slice(0, 8).map((plan) => <Button key={plan.id} uiSize="sm" variant={activePlan?.id === plan.id ? "secondary" : "ghost"} onClick={() => void openPlan(plan.id)}>{plan.displayName?.trim() || typeLabels[plan.type]} · {feedbackPlanConfiguredApproachLabel(plan)} · {planStatusLabel(plan.status)} · {plan.items.length}条</Button>)}</div></div>}
    {isGenerate && activePlan && <div className="feedback-plan-generation" role="status">
      <div className="feedback-plan-generation__summary">
        <div><strong>{typeLabels[activePlan.type]}</strong><span>{planStatusLabel(activePlan.status)} · 最多同时生成 2 条</span></div>
        <Badge tone={activePlan.status === "generation_failed" ? "danger" : activePlan.status === "paused" ? "neutral" : "info"}>{planStatusLabel(activePlan.status)}</Badge>
      </div>
      <LLMRoleAssignmentsPanel workspace={llmWorkspace} showWecom={false} />
      {activePlan.status === "draft" && !legacyGenerationRetired && <div className="feedback-generation-mode-picker">
        <div><strong>{feedbackPlanConfiguredApproachLabel(activePlan)}</strong><span>{configuredGenerationApproachDescription(activePlan)} 生成方式将在首次启动后冻结。</span></div>
        <div><Button onClick={() => void generatePlan(activePlan)} disabled={busy || archivedReadOnly || !canGenerate}>开始生成反馈</Button><span>完成后进入教师编辑与批准；程序核验始终执行。</span></div>
      </div>}
      {activePlan.status === "draft" && legacyGenerationRetired && <StatusBanner tone="warning"><span>{generationApproachDescription(null)}</span><Button uiSize="sm" variant="secondary" onClick={openPlanRevision}>另存为新计划</Button></StatusBanner>}
      <div className="feedback-generation-timing" aria-label="生成计时">
        <div><span>总耗时</span><strong>{activePlan.generationTiming?.startedAt ? formatDuration(activePlan.generationTiming.elapsedMs) : "—"}</strong></div>
        <div><span>{activePlan.type === "class_update" ? "平均每条" : "平均每生"}</span><strong>{formatDuration(activePlan.generationTiming?.averageItemMs)}</strong></div>
        <div><span>生成速度</span><strong>{activePlan.generationTiming?.itemsPerMinute === null || activePlan.generationTiming?.itemsPerMinute === undefined ? "—" : `${activePlan.generationTiming.itemsPerMinute} ${activePlan.type === "class_update" ? "条" : "生"}/分钟`}</strong></div>
        <div><span>计划生成方式</span><strong>{feedbackPlanConfiguredApproachLabel(activePlan)}</strong></div>
      </div>
      <div className="feedback-plan-generation__counts"><span>已完成 {activePlan.generationProgress?.completed ?? 0}/{activePlan.generationProgress?.total ?? activePlan.items.length}</span><span>排队 {activePlan.generationProgress?.queued ?? 0}</span><span>进行中 {activePlan.generationProgress?.running ?? 0}</span><span>失败 {activePlan.generationProgress?.failed ?? activePlan.items.filter((item) => item.status === "generation_failed").length}</span></div>
      <progress max={activePlan.generationProgress?.total || activePlan.items.length || 1} value={activePlan.generationProgress?.completed ?? 0} />
      <div className="feedback-generation-item-times">
        {activePlan.items.map((item) => <div key={item.id}><span>{item.student?.name ?? "班级公共反馈"}<small>{itemGenerationSummary(activePlan, item)}</small></span><Badge tone={item.status === "generation_failed" ? "danger" : item.status === "generating" ? "info" : item.generationDurationMs !== null && item.generationDurationMs !== undefined ? "success" : "neutral"}>{planStatusLabel(item.status)}</Badge><strong>{item.generationDurationMs !== null && item.generationDurationMs !== undefined ? formatDuration(item.generationDurationMs) : item.status === "generating" && item.generationStartedAt ? formatDuration(Date.now() - new Date(item.generationStartedAt).getTime()) : "—"}</strong></div>)}
      </div>
      {activePlan.items.filter((item) => item.status === "generation_failed").map((item) => <StatusBanner key={item.id} tone="danger"><span>{item.student?.name ?? "班级公共反馈"}：{item.generationError || "本条生成失败"} · {itemGenerationSummary(activePlan, item)}</span>{!batchMode && activePlan.generationApproach === "restricted" && feedbackPlanItemActualApproach(item) !== "free" && <Button uiSize="sm" variant="secondary" onClick={() => void retryPlanWithFree(activePlan, [item.id])} disabled={busy || archivedReadOnly || !llmReady || generationActive}>改用自由反馈</Button>}</StatusBanner>)}
      {["in_review", "approved", "partially_approved", "exported", "partially_exported"].includes(activePlan.status) && <div className="feedback-generation-complete"><div><strong>本轮生成已完成</strong><span>计时和每条耗时已保存，稍后从计划历史恢复仍可查看。</span></div><Button onClick={() => workspace.setActiveStep("export")}>查看并编辑反馈</Button></div>}
    </div>}
    {isExport && activePlan && <div className={`feedback-plan-detail ${studioMode ? "feedback-plan-detail--studio" : ""} ${studioMode && externalNavigator ? "feedback-plan-detail--studio-external" : ""}`}>{studioMode && !externalNavigator && <aside className="feedback-plan-studio-sidebar" aria-label={activePlan.type === "class_update" ? "班级公共反馈导航" : "计划学生导航"}><header><strong>{activePlan.type === "class_update" ? `${activePlan.items.length} 条班级公共反馈` : `${activePlan.items.length} 名反馈对象`}</strong><span>一次只处理一条</span></header><div className="feedback-plan-studio-filters">{(["action", "review", "done", "all"] as const).map((filter) => <button type="button" key={filter} className={studioFilter === filter ? "is-active" : ""} onClick={() => setStudioFilter(filter)}>{filter === "action" ? "待处理" : filter === "review" ? "待复核" : filter === "done" ? "已完成" : "全部"}<small>{activePlan.items.filter((item) => studioMatches(item, filter)).length}</small></button>)}</div><div className="feedback-plan-studio-students">{studioItems.length ? studioItems.map((item) => <button type="button" key={item.id} className={studioItemId === item.id ? "is-active" : ""} onClick={() => setStudioItemId(item.id)}><span><strong>{item.student?.name ?? "班级公共反馈"}</strong><small>{item.student?.studentId ?? "公共条目"}</small></span><Badge tone={item.status === "generation_failed" || item.status === "stale" ? "danger" : ["approved", "exported"].includes(item.status) ? "success" : "warning"}>{planStatusLabel(item.status)}</Badge></button>) : <p>当前筛选下没有条目</p>}</div></aside>}<header className="feedback-plan-detail__heading"><div><strong>{typeLabels[activePlan.type]}</strong><span>{activePlan.outputRequirement}</span></div><Badge tone={activePlan.status === "stale" ? "danger" : activePlan.status === "approved" || activePlan.status === "exported" ? "success" : "warning"}>{planStatusLabel(activePlan.status)}</Badge></header>{!studioMode && <div className="feedback-plan-selection-toolbar"><span>已选择 {selectedItemIds.length}/{activePlan.items.length} 条</span><div><Button uiSize="sm" variant="ghost" disabled={archivedReadOnly} onClick={() => setSelectedItemIds(activePlan.items.filter((item) => !["approved", "exported", "stale", "generating", "queued"].includes(item.status)).map((item) => item.id))}>选择可批准项</Button><Button uiSize="sm" variant="ghost" disabled={archivedReadOnly} onClick={() => setSelectedItemIds([])}>清空</Button></div></div>}{visiblePlanItems.map((item) => {
      const composition = parseComposition(item.compositionSnapshot, item.generationConfig?.type ?? activePlan.type, item.composition);
      const audit = item.audit ?? parseObject(item.auditSnapshot);
      const evidence = item.evidence ?? parseObject(item.evidenceSnapshot);
      const assessmentEvidence = evidence.assessmentEvidence || [];
      const requiredEvidenceIds = new Set([
        ...(evidence.teachingEvidence || []),
        ...assessmentEvidence,
      ].filter((entry: { confirmed?: boolean; kind?: string }) => entry.confirmed !== false && entry.kind !== "model_candidate")
        .map((entry: { id: string }) => entry.id));
      const generationPreferences = activePlan.input?.generationPreferences ?? null;
      const effectiveGenerationPreferences = item.generationConfig?.generationPreferences ?? generationPreferences;
      const draft = drafts[item.id] ?? { text: item.finalText ?? composition.draftFeedback ?? "", revision: item.itemRevision };
      const normalizedDraftText = draft.text.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
      const coveredEvidenceIds = new Set((composition.evidenceCoverage || [])
        .filter((coverage) => requiredEvidenceIds.has(coverage.evidenceId)
          && normalizedDraftText.includes(coverage.statement.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "")))
        .map((coverage) => coverage.evidenceId));
      const selectedGenerationInput = parseObject(item.selectedGeneration?.inputSnapshot);
      const initialDraft = parseObject(selectedGenerationInput.draftComposition as Record<string, unknown> | undefined);
      const initialDraftText = typeof initialDraft.draftFeedback === "string" ? stripFeedbackInternalBoundary(initialDraft.draftFeedback) : "";
      const normalizedInitialDraftText = initialDraftText.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
      const initialDraftCoveredEvidenceIds = new Set((Array.isArray(initialDraft.evidenceCoverage) ? initialDraft.evidenceCoverage : [])
        .filter((coverage: { evidenceId?: string; statement?: string }) => (
          Boolean(coverage.evidenceId && coverage.statement)
          && requiredEvidenceIds.has(coverage.evidenceId!)
          && normalizedInitialDraftText.includes(coverage.statement!.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, ""))
        ))
        .map((coverage: { evidenceId: string }) => coverage.evidenceId));
      const auditIssues = audit.items || [];
      const blockedIssues = auditIssues.filter((issue: { code: string }) => isHardFeedbackAuditIssue(issue.code));
      const preference = parseObject(item.student?.communicationPreference?.preferenceSnapshot);
      const pendingPreferenceCandidate = item.student?.communicationPreferenceCandidates?.[0];
      const pendingPreference = parseObject(pendingPreferenceCandidate?.preferenceSnapshot);
      const anchorId = activePlan.rangeEndSessionId || activePlan.sessionId;
      const anchorIndex = rangeSessions.findIndex((session) => session.id === anchorId);
      const futureSessions = anchorIndex >= 0 ? rangeSessions.slice(anchorIndex + 1) : [];
      const followup = (composition.modules || []).find((module: { key: string; content?: string }) => module.key === "followup_observation" || module.key === "teacher_support");
      const taskDraft = taskDrafts[item.id] ?? {
        action: followup?.content || "在后续课次观察该问题是否稳定改善",
        dueType: futureSessions.length ? "session" as const : "date" as const,
        dueSessionId: futureSessions[0]?.id ?? "",
        dueDate: "",
      };
      const itemLabel = item.student?.name ?? (item.studentId ? "学生信息加载失败" : "班级公共反馈");
      const history = "historySnapshot" in evidence ? evidence.historySnapshot : null;
      const historyMetrics = history ? [history.current, ...history.recent]
        .filter((metric, index, metrics) => Boolean(metric) && metrics.findIndex((candidate) => (
          candidate?.sessionId === metric?.sessionId && candidate?.metricId === metric?.metricId
        )) === index)
        .slice(0, 5) : [];
      const studentTrendMetrics: StudentTrendMetric[] = historyMetrics.map((metric, index) => ({
        id: metric.metricId ?? metric.sessionId ?? `history-${index}`,
        date: metric.date,
        scoreA: metric.scoreA,
        scoreB: metric.scoreB,
        scoreC: metric.scoreC,
        scoreD: metric.scoreD,
      }));
      const teachingEvidence = evidence.teachingEvidence || [];
      const evidenceSummary = teachingEvidence.slice(0, 4);
      const taskSummary = item.tasks?.[0]?.action || followup?.content || "暂无当日任务";
      const itemSaving = savingItemIds.includes(item.id);
      const itemDirty = draft.text !== (item.finalText ?? "");
      const activePreferenceItems = ([
        ["长度", preference.length],
        ["形式", preference.deliveryChannel],
        ["电话", preference.phoneContact],
        ["证据", preference.evidence],
        ["术语", preference.terminology],
        ["家庭参与", preference.familyParticipation],
        ["频率", preference.frequency],
      ] as Array<[string, unknown]>).flatMap(([label, value]) => (
        typeof value === "string" && value !== "unknown"
          ? [[label, preferenceLabel(value)] as [string, string]]
          : []
      ));
      const itemImmutable = archivedReadOnly || ["approved", "exported", "generating", "queued", "pause_requested"].includes(item.status);
      const generationConfigImmutable = planHasGenerationTrace(activePlan) || itemImmutable || item.reviewMode === "teacher_edited";
      const auditPending = pendingAuditMessage(item.status);
      const nextStudioItem = activePlan.items.find((candidate) => candidate.id !== item.id && studioMatches(candidate, "action"))
        ?? activePlan.items.find((candidate) => candidate.id !== item.id && studioMatches(candidate, "review"));
      const taskIssueIndex = auditIssues.findIndex((issue: { code: string }) => ["followup_without_task", "promise_without_task"].includes(issue.code));
      const queuePosition = activePlan.items.findIndex((candidate) => candidate.id === item.id) + 1;
      const generationAttempts = item.generationExecution?.attempts ?? [];
      return <article key={item.id} className={`feedback-plan-item ${studioMode ? "feedback-plan-item--studio" : ""}`}>
        <section className="feedback-plan-current-status" data-workspace-section="current_status" aria-label={`${itemLabel}当前状态`}>
          <header className="feedback-plan-item__heading"><label className="feedback-plan-item-select"><input type="checkbox" aria-label={`选择${itemLabel}反馈`} checked={selectedItemIds.includes(item.id)} disabled={itemImmutable} onChange={(event) => setSelectedItemIds((ids) => event.target.checked ? [...new Set([...ids, item.id])] : ids.filter((id) => id !== item.id))} /><span><strong>{itemLabel}</strong><small>{item.student?.studentId || (item.studentId ? "学生关系缺失" : "班级条目")} · 队列 {queuePosition}/{activePlan.items.length} · 版本 {item.itemRevision}</small></span></label><div className="feedback-plan-item__badges"><Badge tone={blockedIssues.length || item.status === "stale" || (item.studentId && !item.student) ? "danger" : item.status === "approved" || item.status === "exported" ? "success" : "warning"}>{planStatusLabel(item.status)}</Badge><Badge tone="neutral">配置：{feedbackPlanConfiguredApproachLabel(activePlan)}</Badge><Badge tone="neutral">{itemGenerationSummary(activePlan, item)}</Badge>{item.generationConfig && <Badge tone="info">独立计划</Badge>}</div></header>
          {studioMode && <div className="feedback-plan-studio-item-actions">
            {legacyGenerationRetired && ["evidence_ready", "paused", "generation_failed"].includes(item.status) && <Button uiSize="sm" variant="secondary" onClick={openPlanRevision} disabled={busy}>另存为受限/自由计划</Button>}
            {!legacyGenerationRetired && item.status === "generation_failed" && !batchMode && <Button uiSize="sm" onClick={() => void retryPlan(activePlan, [item.id])} disabled={busy || archivedReadOnly || !llmReady || generationActive}>重试当前学生</Button>}
            {!legacyGenerationRetired && item.status === "generation_failed" && !batchMode && activePlan.generationApproach === "restricted" && feedbackPlanItemActualApproach(item) !== "free" && <Button uiSize="sm" variant="ghost" onClick={() => void retryPlanWithFree(activePlan, [item.id])} disabled={busy || archivedReadOnly || !llmReady || generationActive}>明确改用自由反馈</Button>}
            {feedbackPlanItemShowsApproval(item.status) && <Button uiSize="sm" onClick={() => void approvePlan(activePlan, [item.id])} disabled={busy || itemDirty || itemImmutable || !item.finalText?.trim() || auditStatus(item) === "blocked"}>批准当前反馈</Button>}
            {(onNextItem || nextStudioItem) && <Button uiSize="sm" variant="ghost" onClick={() => onNextItem ? onNextItem(item.id) : nextStudioItem && setStudioItemId(nextStudioItem.id)}>下一名学生</Button>}
          </div>}
          <section className="feedback-plan-audit-panel" aria-label={`${itemLabel}程序核验结果`}>
            <header><div><strong>程序核验</strong><span>初稿覆盖 {initialDraftCoveredEvidenceIds.size}/{requiredEvidenceIds.size} · 成稿保留 {coveredEvidenceIds.size}/{requiredEvidenceIds.size}</span></div><Badge tone={auditPending ? "warning" : blockedIssues.length ? "danger" : auditIssues.length ? "warning" : "success"}>{auditPending ? "尚未完成核验" : auditStatusLabel(auditStatus(item))}</Badge></header>
            {auditPending
              ? <StatusBanner tone="warning"><div className="feedback-plan-audit-success"><strong>暂不能判断是否通过</strong><span>{auditPending}</span></div></StatusBanner>
              : auditIssues.length === 0
              ? <StatusBanner tone="success"><div className="feedback-plan-audit-success"><strong>程序核验通过</strong><span>仍请教师核对教学判断和最终措辞。</span></div></StatusBanner>
              : auditIssues.map((issue: AuditIssue, index: number) => {
                const guidance = describeAuditIssue(issue);
                const hardBlocked = isHardFeedbackAuditIssue(issue.code);
                return <StatusBanner key={`${issue.code}-${index}`} tone={hardBlocked ? "danger" : "warning"}><div className="feedback-plan-audit-issue"><div><strong>{guidance.area}：{guidance.title}</strong><Badge tone={hardBlocked ? "danger" : "warning"}>{hardBlocked ? "阻断批准" : "需确认"}</Badge></div><p><b>检测结果：</b>{issue.message}</p>{issue.excerpt && <p><b>检测片段：</b>{issue.excerpt}</p>}<p><b>影响：</b>{guidance.impact}</p><p><b>处理建议：</b>{guidance.action}</p>{feedbackPlanItemShowsApproval(item.status) && index === taskIssueIndex && <div className="feedback-plan-task-form"><input aria-label={`${itemLabel}教师任务`} value={taskDraft.action} disabled={itemImmutable} onChange={(event) => setTaskDrafts((current) => ({ ...current, [item.id]: { ...taskDraft, action: event.target.value } }))} /><select aria-label={`${itemLabel}任务截止方式`} value={taskDraft.dueType} disabled={itemImmutable} onChange={(event) => setTaskDrafts((current) => ({ ...current, [item.id]: { ...taskDraft, dueType: event.target.value as TaskDraft["dueType"] } }))}><option value="session" disabled={futureSessions.length === 0}>按课次</option><option value="date">按日期</option></select>{taskDraft.dueType === "session" ? <select aria-label={`${itemLabel}教师任务截止课次`} value={taskDraft.dueSessionId} disabled={itemImmutable} onChange={(event) => setTaskDrafts((current) => ({ ...current, [item.id]: { ...taskDraft, dueSessionId: event.target.value } }))}>{futureSessions.map((session) => <option key={session.id} value={session.id}>{session.date} · {session.code}</option>)}</select> : <input aria-label={`${itemLabel}任务截止日期`} type="date" value={taskDraft.dueDate} disabled={itemImmutable} onChange={(event) => setTaskDrafts((current) => ({ ...current, [item.id]: { ...taskDraft, dueDate: event.target.value } }))} />}<Button uiSize="sm" variant="secondary" onClick={() => void createTask(activePlan, item)} disabled={busy || itemImmutable || !taskDraft.action.trim() || (taskDraft.dueType === "date" && !taskDraft.dueDate)}>批准并创建教师任务</Button></div>}</div></StatusBanner>;
              })}
          </section>
          {item.studentId && !item.student && <StatusBanner tone="danger">学生身份没有加载完整，已禁止把该条目当作班级公共反馈。请刷新计划后重试。</StatusBanner>}
          {item.status === "stale" && <StatusBanner tone="warning">来源信息已更新，但当前正文仍然保留。你可以直接修改并保存或点击顶部“保留现有正文”；需要换用最新事实或生成设置时，请回到“规划”建立另一份计划。</StatusBanner>}
        </section>

        <section className="feedback-plan-workspace-section feedback-plan-final-editor" data-workspace-section="teacher_final_text" aria-label={`${itemLabel}教师最终正文`}>
          <div className="feedback-plan-card-label"><strong>教师最终正文</strong><span>首屏主要工作区 · 批准与导出唯一权威</span></div>
          <div className="feedback-plan-editor"><Textarea aria-label={`${itemLabel}反馈计划文本`} rows={10} value={draft.text} onChange={(event) => { const text = event.target.value; setDrafts((current) => ({ ...current, [item.id]: { ...draft, text } })); }} disabled={busy || itemImmutable || Boolean(item.studentId && !item.student)} /><div className="feedback-plan-editor__actions"><span>{draft.text.length} 个字符 · {itemSaving ? "保存中" : itemDirty ? "等待约 800ms 自动保存" : "已保存"}</span><Button uiSize="sm" onClick={() => void saveItem(item)} disabled={busy || itemSaving || itemImmutable || Boolean(item.studentId && !item.student) || !itemDirty}>{itemSaving ? "保存中…" : !itemDirty ? "已保存" : item.status === "stale" ? "保留当前正文并复核" : "立即保存"}</Button></div></div>
        </section>

        <section className="feedback-plan-workspace-section feedback-plan-plan-content" data-workspace-section="plan_content" aria-label={`${itemLabel}计划内容`}>
          <div className="feedback-plan-card-label"><strong>计划内容</strong><span>生成开始后的冻结边界不变</span></div>
          <div className="feedback-plan-generation-preferences feedback-plan-generation-preferences--readonly">
            <strong>{item.generationConfig ? "学生独立计划" : generationPreferences ? "沿用公共计划" : legacyGenerationRetired ? "旧生成配置（只读）" : "计划配置"}</strong>
            <span>反馈类型：{typeLabels[item.generationConfig?.type ?? activePlan.type]}</span>
            <span>生成方式：{feedbackPlanConfiguredApproachLabel(activePlan)}</span>
            <span>总体要求：{item.generationConfig?.outputRequirement || activePlan.outputRequirement}</span>
            {effectiveGenerationPreferences ? <><span>结尾：{closureLabels[effectiveGenerationPreferences.closureType] || effectiveGenerationPreferences.closureType}</span><span>详略：{generationPreferenceLabel(effectiveGenerationPreferences.length, generationLengthLabels)} · 语气：{generationPreferenceLabel(effectiveGenerationPreferences.tone, generationToneLabels)}</span><span>模块：{effectiveGenerationPreferences.moduleKeys.length ? effectiveGenerationPreferences.moduleKeys.map((key) => moduleLabels[key] || key).join("、") : "未预选，按当前类型自然组织"}</span></> : <span>{configuredGenerationApproachDescription(activePlan)}</span>}
            {item.studentId && item.student && !legacyGenerationRetired && <Button uiSize="sm" variant="secondary" onClick={() => openIndependentItem(item)} disabled={busy || generationConfigImmutable} title={generationConfigImmutable ? "已编辑、批准或正在处理的条目不能覆盖计划配置" : undefined}>{item.generationConfig ? "调整独立计划" : "设置独立计划"}</Button>}
          </div>
        </section>

        <section className="feedback-plan-workspace-section feedback-plan-student-facts" data-workspace-section="student_facts" aria-label={`${itemLabel}学生事实`}>
          <div className="feedback-plan-card-label"><strong>学生事实</strong><span>确定性事实与模型建议分开</span></div>
          <div className="feedback-plan-facts-grid">
            <section className="feedback-plan-fact-card"><div className="feedback-plan-card-label"><strong>已确认课堂事实</strong><span>{teachingEvidence.length} 条</span></div><div className="feedback-plan-fact-list">{evidenceSummary.length ? evidenceSummary.map((entry: { id?: string; content: string }, index: number) => <p key={entry.id ?? index}>{entry.content}</p>) : <p className="is-empty">暂无已确认课堂证据</p>}</div></section>
            <section className="feedback-plan-fact-card"><div className="feedback-plan-card-label"><strong>测评摘要</strong><span>{assessmentEvidence.length} 条</span></div><div className="feedback-plan-fact-list">{assessmentEvidence.length ? assessmentEvidence.slice(0, 4).map((entry: { id?: string; content: string }, index: number) => <p key={entry.id ?? index}>{entry.content}</p>) : <p className="is-empty">暂无已确认测评证据</p>}</div></section>
            <section className="feedback-plan-compact-card"><strong>沟通偏好</strong><p>{activePreferenceItems.length ? activePreferenceItems.map(([label, value]) => `${label} ${value}`).join(" · ") : "未设置"}</p></section>
            <section className="feedback-plan-compact-card"><strong>教师任务</strong><p>{taskSummary}</p></section>
          </div>
          {pendingPreferenceCandidate && <details className="feedback-plan-preference" open><summary>发现新的家庭沟通偏好，等待确认</summary><div className="feedback-plan-preference__candidate"><p>待确认：长度 {preferenceLabel(pendingPreference.length)} · 形式 {preferenceLabel(pendingPreference.deliveryChannel)} · 电话 {preferenceLabel(pendingPreference.phoneContact)} · 频率 {preferenceLabel(pendingPreference.frequency)}</p><div><Button uiSize="sm" onClick={() => void resolvePreferenceCandidate(item, pendingPreferenceCandidate.id, "confirmed")} disabled={busy || archivedReadOnly}>确认并用于反馈</Button><Button uiSize="sm" variant="ghost" onClick={() => void resolvePreferenceCandidate(item, pendingPreferenceCandidate.id, "rejected")} disabled={busy || archivedReadOnly}>不是偏好</Button></div></div></details>}
        </section>

        <section className="feedback-plan-workspace-section feedback-plan-student-trends" data-workspace-section="student_trends" aria-label={`${itemLabel}学生趋势`}>
          <div className="feedback-plan-card-label"><strong>学生趋势</strong><span>本学期最近 {studentTrendMetrics.length} 个有效样本；缺失值不按 0 处理</span></div>
          {studentTrendMetrics.length > 0 ? <div className="feedback-plan-student-trend"><StudentTrendChart metrics={studentTrendMetrics} compact title="最近课堂评价" /><p>时间范围：{studentTrendMetrics.at(-1)?.date ?? "—"} 至 {studentTrendMetrics[0]?.date ?? "—"} · 学期均值 A{history?.semesterAverage?.A ?? "—"} · B{history?.semesterAverage?.B ?? "—"} · C{history?.semesterAverage?.C ?? "—"} · D{history?.semesterAverage?.D ?? "—"}</p></div> : <p className="feedback-plan-section-empty">当前没有足够的有效课堂评价样本，暂不绘制趋势。</p>}
        </section>

        <details className="feedback-plan-advanced" data-workspace-section="advanced">
          <summary><span><strong>高级选项</strong><small>详细证据、生成轨迹、模型初稿、任务历史与附件</small></span><span className="feedback-plan-advanced__hint">按需展开</span></summary>
          <div className="feedback-plan-advanced__body">
            {initialDraftText && <section className="feedback-plan-model-suggestion"><div className="feedback-plan-card-label"><strong>模型初稿（只读）</strong><span>仅供与教师最终正文比较</span></div><p>{initialDraftText}</p></section>}
            {(teachingEvidence.length > evidenceSummary.length || assessmentEvidence.length > 0) && <section className="feedback-plan-diagnostic-card"><strong>详细证据</strong>{teachingEvidence.map((entry: { id?: string; content: string }, index: number) => <p key={`teaching-${entry.id ?? index}`}>{entry.content}</p>)}{assessmentEvidence.map((entry: { id?: string; content: string }, index: number) => <p key={`assessment-${entry.id ?? index}`}>测评：{entry.content}</p>)}</section>}
            <section className="feedback-plan-diagnostic-card"><strong>生成轨迹</strong><p>{legacyGenerationRetired ? "旧生成方式已退役，历史轨迹只读。" : `${itemGenerationSummary(activePlan, item)}；请求方式 ${item.generationExecution?.requestedApproach ? feedbackGenerationApproachLabel(item.generationExecution.requestedApproach) : feedbackPlanConfiguredApproachLabel(activePlan)}。`}</p>{generationAttempts.length ? generationAttempts.map((attempt, index) => <p key={`${attempt.actualApproach}-${index}`}>第 {index + 1} 次：{feedbackGenerationApproachLabel(attempt.actualApproach)}{feedbackGenerationStageLabel(attempt.stage) ? ` · ${feedbackGenerationStageLabel(attempt.stage)}` : ""}{feedbackGenerationErrorKindLabel(attempt.error?.kind) ? ` · ${feedbackGenerationErrorKindLabel(attempt.error?.kind)}` : ""} · {attempt.status}</p>) : <p>尚无执行尝试。</p>}</section>
            {auditIssues.length > 0 && <section className="feedback-plan-diagnostic-card"><strong>技术核验码</strong><p>{auditIssues.map((issue: AuditIssue) => issue.code).join(" · ")}</p></section>}
            {item.tasks?.map((task) => <p className="feedback-plan-task" key={task.id}>教师任务：{task.action} · {task.status}</p>)}
            {item.attachments?.map((attachment) => <div className={`feedback-plan-attachment ${attachment.status === "missing" ? "is-missing" : ""}`} key={attachment.id}><span>发送附件：{attachment.displayName} · {attachment.sizeBytes}B · {attachment.status === "missing" ? "文件缺失，不能导出" : attachment.status}</span><Button uiSize="sm" variant="ghost" onClick={() => void removeAttachment(activePlan, attachment.id)} disabled={busy || itemImmutable}>移除</Button></div>)}
            {isExport && <label className="feedback-plan-attachment-picker">标记发送附件<input type="file" onChange={(event) => void uploadAttachment(activePlan, item, event.target.files?.[0])} disabled={busy || item.status === "stale" || itemImmutable} /></label>}
          </div>
        </details>
      </article>;
    })}</div>}
    {isExport && activePlan?.exportRuns && activePlan.exportRuns.length > 0 && <div className="feedback-plan-exports"><strong>导出记录</strong>{activePlan.exportRuns.slice(0, 5).map((run, index) => { const isFirst = index === activePlan.exportRuns!.length - 1; const label = run.isRepeat ? "重复导出" : isFirst ? "首次导出" : run.mode === "approved_only" ? "补导" : "完整导出"; return <span key={run.id}>{label} · {new Date(run.createdAt).toLocaleString("zh-CN")} · {run.manifestHash.slice(0, 10)}…</span>; })}</div>}
    <FeedbackPlanGenerationConfigDialog
      open={Boolean(independentStudentTarget)}
      studentName={independentStudentTarget?.name ?? ""}
      initialConfig={independentStudentConfig}
      onClose={() => setIndependentStudentTarget(null)}
      onSave={saveIndependentStudent}
      onReset={studentOverrides[independentStudentTarget?.id ?? ""] ? resetIndependentStudent : undefined}
      busy={busy}
    />
    <FeedbackPlanGenerationConfigDialog
      open={Boolean(independentItemTarget)}
      studentName={independentItemTarget?.studentName ?? ""}
      initialConfig={independentItemConfig}
      onClose={() => setIndependentItemTarget(null)}
      onSave={saveIndependentItem}
      onReset={independentItemTarget?.item.generationConfig ? () => saveIndependentItem(null) : undefined}
      busy={busy}
      error={error}
    />
  </Section>;
}
