import { z } from "zod";
import { StudentAssessmentEvidenceSchema } from "@/lib/contracts/feedback";

export const FEEDBACK_PLAN_TYPES = ["class_update", "event_micro", "stage_trend", "course_end"] as const;
export type FeedbackPlanType = typeof FEEDBACK_PLAN_TYPES[number];

export const FEEDBACK_CLOSURE_TYPES = [
  "informational",
  "positive_recognition",
  "teacher_resolved",
  "home_cooperation",
  "continued_observation",
] as const;
export type FeedbackClosureType = typeof FEEDBACK_CLOSURE_TYPES[number];

export const FEEDBACK_CLOSURES_BY_TYPE = {
  class_update: ["informational"],
  event_micro: ["positive_recognition", "teacher_resolved", "home_cooperation", "continued_observation"],
  stage_trend: ["positive_recognition", "home_cooperation", "continued_observation"],
  course_end: ["positive_recognition", "home_cooperation"],
} as const satisfies Record<FeedbackPlanType, readonly FeedbackClosureType[]>;

export const PARENT_ACTION_TYPES = ["remind", "confirm", "provide_conditions", "report_anomaly"] as const;
export type ParentActionType = typeof PARENT_ACTION_TYPES[number];

export const FEEDBACK_MODULES = {
  class_update: ["lesson_scope", "key_difficulty", "class_handling", "homework_review", "next_lesson_link"],
  event_micro: ["observed_moment", "teacher_interpretation", "teacher_intervention", "intervention_outcome", "parent_action", "followup_observation"],
  stage_trend: ["starting_point", "recent_trend", "stable_capability", "unresolved_issue", "teacher_support", "next_stage_focus", "parent_action", "followup_observation"],
  course_end: ["starting_state", "evidence_backed_change", "stable_capability", "remaining_gap", "next_stage_learning_path", "parent_action"],
} as const;

export type FeedbackModuleKey = (typeof FEEDBACK_MODULES)[FeedbackPlanType][number];

const sourceRefSchema = z.object({
  type: z.string().min(1).max(80),
  id: z.string().min(1).max(200),
  label: z.string().max(500).optional(),
});

const evidenceItemSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["fact", "teacher_judgment", "model_candidate"]),
  content: z.string().min(1).max(3000),
  sourceRefs: z.array(sourceRefSchema).max(20),
  occurredAt: z.string().max(64).optional(),
  confirmed: z.boolean().default(false),
});

export const FeedbackEvidenceBundleSchema = z.object({
  version: z.literal(1),
  planType: z.enum(FEEDBACK_PLAN_TYPES),
  studentId: z.string().max(200).nullable(),
  teachingEvidence: z.array(evidenceItemSchema).max(100),
  assessmentEvidence: z.array(evidenceItemSchema).max(50).default([]),
  communicationContext: z.array(evidenceItemSchema).max(50),
  executionConstraints: z.object({
    existingTaskIds: z.array(z.string().max(200)).max(50),
    fixedArrangementRefs: z.array(sourceRefSchema).max(50),
    teacherInterventionPresent: z.boolean(),
  }),
  sourceRefs: z.array(sourceRefSchema).max(100),
  sourceFingerprint: z.string().min(16).max(128),
});
export type FeedbackEvidenceBundle = z.infer<typeof FeedbackEvidenceBundleSchema>;

const moduleStatusSchema = z.enum(["included", "omitted", "blocked"]);

export const FeedbackModuleSchema = z.object({
  key: z.string().min(1).max(100),
  content: z.string().max(5000),
  evidenceRefs: z.array(z.string().max(200)).max(200),
  status: moduleStatusSchema,
  reason: z.string().max(500),
});
export type FeedbackModule = z.infer<typeof FeedbackModuleSchema>;

export const FeedbackCompositionPlanSchema = z.object({
  version: z.literal(1),
  closureType: z.enum(FEEDBACK_CLOSURE_TYPES),
  needParentAction: z.boolean(),
  parentAction: z.object({
    type: z.enum(PARENT_ACTION_TYPES),
    actor: z.literal("parent"),
    action: z.string().min(1).max(1000),
    successCriteria: z.string().max(500),
    notNeeded: z.string().max(500),
  }).nullable(),
  modules: z.array(FeedbackModuleSchema).max(12),
  evidenceCoverage: z.array(z.object({
    evidenceId: z.string().min(1).max(200),
    statement: z.string().trim().min(2).max(1000),
  })).max(150).default([]),
  draftFeedback: z.string().max(10000),
});
export type FeedbackCompositionPlan = z.infer<typeof FeedbackCompositionPlanSchema>;

export const FeedbackAuditItemSchema = z.object({
  code: z.string().min(1).max(100),
  severity: z.enum(["info", "requires_teacher", "blocked"]),
  message: z.string().min(1).max(1000),
  excerpt: z.string().max(500).optional(),
  taskId: z.string().max(200).optional(),
});

export const FeedbackAuditSnapshotSchema = z.object({
  version: z.literal(1),
  status: z.enum(["pass", "needs_review", "blocked"]),
  items: z.array(FeedbackAuditItemSchema).max(100),
  textHash: z.string().max(128),
  semanticReviewRequired: z.boolean(),
});
export type FeedbackAuditSnapshot = z.infer<typeof FeedbackAuditSnapshotSchema>;

export const CommunicationPreferenceSchema = z.object({
  version: z.literal(1),
  length: z.enum(["unknown", "short", "standard", "detailed", "flexible"]),
  deliveryChannel: z.enum(["unknown", "text", "voice", "either"]).default("unknown"),
  phoneContact: z.enum(["unknown", "accepted", "not_accepted"]).default("unknown"),
  evidence: z.enum(["unknown", "teacher_conclusion", "classroom_example", "data_trend"]),
  terminology: z.enum(["unknown", "plain", "basic", "professional"]),
  familyParticipation: z.enum(["unknown", "inform_only", "remind_confirm", "observe_report", "simple_check"]),
  frequency: z.enum(["unknown", "every_session", "stage_only", "exception_only"]),
});
export type CommunicationPreference = z.infer<typeof CommunicationPreferenceSchema>;

const feedbackPlanAssessmentEvidenceValueSchema = z.union([
  StudentAssessmentEvidenceSchema,
  z.array(StudentAssessmentEvidenceSchema).min(1).max(20),
]);

export const FeedbackPlanAssessmentEvidenceSchema = z.record(
  z.string().trim().min(1).max(200),
  feedbackPlanAssessmentEvidenceValueSchema,
).refine((value) => Object.keys(value).length <= 200, {
  message: "assessmentEvidence cannot contain more than 200 students",
});
export type FeedbackPlanAssessmentEvidenceInput = z.infer<typeof FeedbackPlanAssessmentEvidenceSchema>;

export const FeedbackPlanCreateSchema = z.object({
  type: z.enum(FEEDBACK_PLAN_TYPES),
  purpose: z.string().trim().min(1).max(500),
  semesterId: z.string().trim().min(1).max(200),
  classId: z.string().trim().min(1).max(200),
  sessionId: z.string().trim().max(200).optional(),
  rangeStartSessionId: z.string().trim().max(200).optional(),
  rangeEndSessionId: z.string().trim().max(200).optional(),
  studentIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  assessmentEvidence: FeedbackPlanAssessmentEvidenceSchema.optional(),
});
export type FeedbackPlanCreateInput = z.infer<typeof FeedbackPlanCreateSchema>;

export const FeedbackPlanItemPatchSchema = z.object({
  composition: FeedbackCompositionPlanSchema.optional(),
  finalText: z.string().max(10000).optional(),
  reviewMode: z.enum(["model", "teacher_edited"]).optional(),
  expectedItemRevision: z.number().int().positive().optional(),
});
export type FeedbackPlanItemPatch = z.infer<typeof FeedbackPlanItemPatchSchema>;

export function stableJson(value: unknown) {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

// 只拦截明确面向教师内部的语境；“分子模型”“原子模型”等学科词汇属于正常教学事实。
const INTERNAL_CONTENT = /(?:续班(?:建议|判断|结论)?|退班(?:建议|判断|意向)?|销售(?:话术|文案|结论)?|(?:AI|LLM|语言模型)(?:生成|审核|润色|反馈)?|内部研判|风险标签|教师任务)/iu;
const PROMISE_PATTERNS = [
  /我会(?:继续|单独|额外|及时|持续|下次)/u,
  /(?:老师|我)(?:会|将会|将在).{0,24}(?:检查|观察|复测|沟通|安排|反馈|跟进|关注)/u,
  /下次(?:课|测验).{0,20}(?:检查|观察|复测|沟通|安排)/u,
  /后续(?:继续|重点|跟进|关注)/u,
  /持续关注/u,
  /随时联系/u,
  /每天(?:跟进|监督)/u,
  /保证(?:掌握|提高|完成)/u,
];
// 课堂里“提醒学生”“确认掌握”不是家长动作。只有明确指向家长/您，或出现
// “家长可以/只需要”等主体时，才把文本视为家长动作。
const PARENT_ACTION_PATTERNS = /(?:请(?:您|家长)|麻烦(?:您|家长)|(?:希望|建议)家长|家长(?:可以|只需要|只需|需要|需|这边))/u;

function coverageText(value: string) {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLocaleLowerCase("zh-CN");
}

function evidenceStatementMatches(evidenceContent: string, statement: string) {
  const normalizedEvidence = coverageText(evidenceContent);
  const normalizedStatement = coverageText(statement);
  const numericTokens = [...new Set(evidenceContent.match(/\d+(?:\.\d+)?%?/g) ?? [])];
  if (numericTokens.length > 0 && !numericTokens.some((token) => normalizedStatement.includes(coverageText(token)))) {
    return false;
  }
  const hanRuns = evidenceContent.match(/[\p{Script=Han}]+/gu) ?? [];
  const bigrams = new Set(hanRuns.flatMap((run) => (
    [...run].slice(0, -1).map((character, index) => `${character}${[...run][index + 1]}`)
  )));
  const overlappingBigrams = [...bigrams].filter((token) => normalizedStatement.includes(token));
  return normalizedEvidence.includes(normalizedStatement)
    || normalizedStatement.includes(normalizedEvidence)
    || overlappingBigrams.length >= Math.min(2, bigrams.size);
}

export function validateCompositionForBundle(
  composition: FeedbackCompositionPlan,
  bundle: FeedbackEvidenceBundle,
  taskIds: Set<string> = new Set(bundle.executionConstraints.existingTaskIds),
  identity?: { studentName?: string; otherStudentNames?: string[] },
  options: { requireAllEvidenceInText?: boolean } = {},
): { status: FeedbackAuditSnapshot["status"]; issues: z.infer<typeof FeedbackAuditItemSchema>[] } {
  const issues: z.infer<typeof FeedbackAuditItemSchema>[] = [];
  const included = composition.modules.filter((module) => module.status === "included");
  const evidence = bundle.teachingEvidence.concat(bundle.assessmentEvidence, bundle.communicationContext);
  const evidenceIds = new Set(evidence.filter((item) => item.confirmed && item.kind !== "model_candidate").map((item) => item.id));
  const allowedModules = new Set(FEEDBACK_MODULES[bundle.planType]);
  const allowedClosures = new Set<FeedbackClosureType>(FEEDBACK_CLOSURES_BY_TYPE[bundle.planType]);

  if (!composition.draftFeedback.trim()) {
    issues.push({ code: "empty_text", severity: "blocked", message: "最终反馈文本为空" });
  }
  if (included.length < 2 || included.length > 4) {
    issues.push({ code: "module_count_invalid", severity: "blocked", message: "每条反馈必须选择两到四个有价值的模块" });
  }
  for (const section of included) {
    if (!allowedModules.has(section.key as never)) {
      issues.push({ code: "module_not_allowed", severity: "blocked", message: `当前反馈类型不允许模块：${section.key}` });
    }
    if (section.evidenceRefs.some((ref) => !evidenceIds.has(ref))) {
      issues.push({ code: "evidence_ref_missing", severity: "blocked", message: `模块 ${section.key} 引用了不存在的证据` });
    }
  }
  const requiredEvidenceIds = new Set(bundle.teachingEvidence.concat(bundle.assessmentEvidence)
    .filter((item) => item.confirmed && item.kind !== "model_candidate")
    .map((item) => item.id));
  const includedEvidenceIds = new Set(included.flatMap((module) => module.evidenceRefs));
  const omittedEvidenceIds = [...requiredEvidenceIds].filter((id) => !includedEvidenceIds.has(id));
  if (options.requireAllEvidenceInText && omittedEvidenceIds.length > 0) {
    issues.push({
      code: "confirmed_evidence_omitted",
      severity: "blocked",
      message: `反馈尚未覆盖全部已确认的教学与测评证据：${omittedEvidenceIds.join("、")}`,
    });
  }
  const coverageByEvidenceId = new Map<string, string>();
  const duplicateCoverageIds = new Set<string>();
  for (const coverage of composition.evidenceCoverage) {
    if (coverageByEvidenceId.has(coverage.evidenceId)) duplicateCoverageIds.add(coverage.evidenceId);
    coverageByEvidenceId.set(coverage.evidenceId, coverage.statement);
  }
  if (duplicateCoverageIds.size > 0) {
    issues.push({
      code: "evidence_coverage_duplicate",
      severity: "blocked",
      message: `同一证据不能重复声明正文覆盖：${[...duplicateCoverageIds].join("、")}`,
    });
  }
  const unknownCoverageIds = [...coverageByEvidenceId.keys()].filter((id) => !requiredEvidenceIds.has(id));
  if (unknownCoverageIds.length > 0) {
    issues.push({
      code: "evidence_coverage_unknown",
      severity: "blocked",
      message: `正文覆盖声明引用了非教学/测评证据：${unknownCoverageIds.join("、")}`,
    });
  }
  const missingTextCoverageIds: string[] = [];
  const invalidTextCoverageIds: string[] = [];
  const normalizedDraft = coverageText(composition.draftFeedback);
  for (const evidenceItem of bundle.teachingEvidence.concat(bundle.assessmentEvidence)
    .filter((item) => item.confirmed && item.kind !== "model_candidate")) {
    const statement = coverageByEvidenceId.get(evidenceItem.id);
    if (!statement) {
      if (options.requireAllEvidenceInText) missingTextCoverageIds.push(evidenceItem.id);
      continue;
    }
    if (!normalizedDraft.includes(coverageText(statement))) {
      missingTextCoverageIds.push(evidenceItem.id);
      continue;
    }
    if (!evidenceStatementMatches(evidenceItem.content, statement)) invalidTextCoverageIds.push(evidenceItem.id);
  }
  if (missingTextCoverageIds.length > 0) {
    issues.push({
      code: "confirmed_evidence_text_omitted",
      severity: "blocked",
      message: `以下已确认教学与测评证据没有对应到最终反馈正文：${missingTextCoverageIds.join("、")}`,
    });
  }
  if (invalidTextCoverageIds.length > 0) {
    issues.push({
      code: "evidence_coverage_unsubstantiated",
      severity: "blocked",
      message: `以下正文覆盖句与对应证据缺少数字或关键词关联：${invalidTextCoverageIds.join("、")}`,
    });
  }
  if (!options.requireAllEvidenceInText) {
    const intentionallyOmittedIds = [...requiredEvidenceIds].filter((id) => !coverageByEvidenceId.has(id));
    if (intentionallyOmittedIds.length > 0) {
      issues.push({
        code: "final_evidence_omitted",
        severity: "requires_teacher",
        message: `最终成稿未保留以下初稿证据，请教师确认是否接受本次删减：${intentionallyOmittedIds.join("、")}`,
      });
    }
  }
  const unconfirmedRef = included.flatMap((module) => module.evidenceRefs).find((ref) => evidence.some((item) => item.id === ref && (!item.confirmed || item.kind === "model_candidate")));
  if (unconfirmedRef) {
    issues.push({ code: "unconfirmed_evidence", severity: "blocked", message: `引用的证据 ${unconfirmedRef} 尚未由教师确认` });
  }
  if (composition.needParentAction !== Boolean(composition.parentAction)) {
    issues.push({ code: "parent_action_mismatch", severity: "blocked", message: "家长动作开关与动作内容不一致" });
  }
  if (composition.parentAction && !composition.needParentAction) {
    issues.push({ code: "parent_action_disabled", severity: "blocked", message: "未启用家长动作时不能包含家庭任务" });
  }
  if (composition.parentAction && !included.some((module) => module.key === "parent_action")) {
    issues.push({ code: "parent_action_module_missing", severity: "blocked", message: "家长动作必须通过家长动作模块进入反馈" });
  }
  if (included.some((module) => module.key === "parent_action") && (!composition.needParentAction || !composition.parentAction)) {
    issues.push({ code: "parent_action_content_missing", severity: "blocked", message: "家长动作模块必须关联合法的家长动作内容" });
  }
  if (included.some((module) => module.key === "teacher_intervention" || module.key === "teacher_support")
    && !bundle.executionConstraints.teacherInterventionPresent) {
    issues.push({ code: "teacher_intervention_unconfirmed", severity: "blocked", message: "没有已确认的教师处理证据" });
  }
  if (included.some((module) => module.key === "intervention_outcome")
    && !included.some((module) => module.key === "teacher_intervention")) {
    issues.push({ code: "intervention_outcome_without_action", severity: "blocked", message: "处理结果必须依赖教师处理" });
  }
  if (included.some((module) => module.key === "followup_observation") && taskIds.size === 0) {
    issues.push({ code: "followup_without_task", severity: "blocked", message: "后续观察必须关联已存在或已批准的教师任务" });
  }
  if (composition.closureType === "continued_observation" && !included.some((module) => module.key === "followup_observation")) {
    issues.push({ code: "closure_requires_followup", severity: "blocked", message: "继续观察结尾必须包含后续观察模块" });
  }
  if (composition.closureType === "teacher_resolved" && !included.some((module) => module.key === "teacher_intervention")) {
    issues.push({ code: "closure_requires_intervention", severity: "blocked", message: "教师已处理结尾必须包含已确认的教师处理模块" });
  }
  if (composition.closureType === "home_cooperation" && !composition.needParentAction) {
    issues.push({ code: "closure_requires_parent_action", severity: "blocked", message: "家庭配合结尾必须启用家长动作" });
  }
  if (!allowedClosures.has(composition.closureType)) {
    issues.push({ code: "closure_not_allowed", severity: "blocked", message: `当前反馈类型不能使用 ${composition.closureType} 结尾` });
  }
  if (INTERNAL_CONTENT.test(composition.draftFeedback)) {
    issues.push({ code: "internal_content_leak", severity: "blocked", message: "反馈包含教师内部信息" });
  }
  if (identity?.otherStudentNames?.some((name) => name && name !== identity.studentName && composition.draftFeedback.includes(name))) {
    issues.push({ code: "cross_student_content", severity: "blocked", message: "反馈文本出现其他学生姓名" });
  }
  if (PARENT_ACTION_PATTERNS.test(composition.draftFeedback) && !composition.needParentAction) {
    issues.push({ code: "implicit_parent_action", severity: "blocked", message: "文本出现家庭动作但未启用家长动作模块" });
  }
  const promiseDetected = PROMISE_PATTERNS.find((pattern) => pattern.test(composition.draftFeedback));
  if (promiseDetected && taskIds.size === 0) {
    issues.push({ code: "promise_without_task", severity: "blocked", message: "反馈包含教师未来动作但没有关联任务" });
  } else if (promiseDetected) {
    issues.push({ code: "promise_requires_teacher", severity: "requires_teacher", message: "反馈包含教师未来动作，请确认任务范围与截止节点" });
  }

  const status = issues.some((issue) => issue.severity === "blocked")
    ? "blocked"
    : issues.some((issue) => issue.severity === "requires_teacher") ? "needs_review" : "pass";
  return { status, issues };
}
