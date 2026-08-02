import { createHash } from "node:crypto";
import { getLLMCompletionOptions, type createLLMClient } from "@/lib/llm";
import {
  assessmentEvidencePrompt,
  fallbackLessonSummary,
  lessonMaterialHasContent,
  lessonMaterialPrompt,
  lessonMaterialSummarySource,
  privateFeedbackTemplatePrompt,
  type LessonFeedbackMaterial,
  type StudentAssessmentEvidence,
} from "@/lib/feedback-materials";
import {
  feedbackLengthRequirement,
  feedbackStyleInstruction,
  type FeedbackLength,
  type FeedbackOutputStrategy,
  type FeedbackSections,
  type FeedbackStyle,
} from "@/lib/feedback-sections";
import {
  containsRecipientPlaceholder,
  sanitizeFeedbackPromptText,
} from "@/lib/feedback-text-safety";
import {
  FEEDBACK_CLOSURES_BY_TYPE,
  FEEDBACK_MODULES,
  FeedbackCompositionPlanSchema,
  FeedbackEvidenceBundleSchema,
  type FeedbackCompositionPlan,
  type FeedbackEvidenceBundle,
  type FeedbackPlanType,
} from "@/lib/feedback-plan";
import { ApiError } from "@/lib/api-errors";
import { createAuditSnapshot } from "@/services/feedback-plan-audit";

const FEEDBACK_DRAFT_INITIAL_MAX_TOKENS = 2048;
const FEEDBACK_DRAFT_RETRY_MAX_TOKENS = 4096;
const FEEDBACK_REVIEW_MAX_TOKENS = 4096;
// 常规反馈同样会经过推理模型。先给出够用的预算；若服务端明确返回
// finish_reason=length，再用和审核阶段相同的上限重试一次，避免把一段
// 已经被推理耗尽的空响应误判成“模型不会生成”。
const FEEDBACK_ROUTINE_INITIAL_MAX_TOKENS = 2048;
const FEEDBACK_ROUTINE_RETRY_MAX_TOKENS = 4096;
const LESSON_SUMMARY_INITIAL_MAX_TOKENS = 1536;
const LESSON_SUMMARY_RETRY_MAX_TOKENS = 3072;
const FEEDBACK_MAX_ATTEMPTS = 2;

type LLMClient = ReturnType<typeof createLLMClient>;

export type FeedbackReviewStatus = "passed" | "revised" | "needs_review" | "edited";

export interface ReviewedFeedback {
  draftFeedback: string;
  feedback: string;
  reviewStatus: Exclude<FeedbackReviewStatus, "edited">;
  reviewIssues: string[];
}

export interface FeedbackDraftInput {
  studentName: string;
  promptContext: string;
  style: FeedbackStyle;
  length: FeedbackLength;
  profileId?: string;
  client: LLMClient;
  model: string;
  signal?: AbortSignal;
}

export interface FeedbackReviewInput extends FeedbackDraftInput {
  draftFeedback: string;
  forbiddenStudentNames?: string[];
}

export interface GenerateReviewedFeedbackInput {
  studentName: string;
  promptContext: string;
  forbiddenStudentNames?: string[];
  style: FeedbackStyle;
  length: FeedbackLength;
  profileId?: string;
  draftClient: LLMClient;
  draftModel: string;
  reviewClient: LLMClient;
  reviewModel: string;
  signal?: AbortSignal;
}

export interface GenerateRoutineFeedbackInput {
  studentName: string;
  promptContext: string;
  forbiddenStudentNames?: string[];
  style: FeedbackStyle;
  length: FeedbackLength;
  profileId?: string;
  client: LLMClient;
  model: string;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("反馈生成已取消", "AbortError");
  }
}

interface ReviewPayload {
  verdict?: unknown;
  feedback?: unknown;
  issues?: unknown;
}

export function composeFeedbackPromptContext(input: {
  studentContext: string;
  sessionCode?: string;
  studentId?: string;
  lessonMaterial?: LessonFeedbackMaterial | null;
  assessmentEvidence?: StudentAssessmentEvidence | null;
  sections?: FeedbackSections;
  outputStrategy?: FeedbackOutputStrategy;
}) {
  const selectedSections = input.sections && input.outputStrategy
    ? [
        `【本次已确认事实】${input.sections.currentFact.content}`,
        input.outputStrategy.flaggedIssue && input.sections.flaggedIssue ? `【挂牌问题】${input.sections.flaggedIssue.content}` : "",
        input.outputStrategy.trendChange && input.sections.trendChange ? `【趋势变化】${input.sections.trendChange.content}` : "",
        input.outputStrategy.backgroundBaseline && input.sections.backgroundBaseline ? `【背景基线】${input.sections.backgroundBaseline.content}` : "",
        input.outputStrategy.strategySuggestion && input.sections.strategySuggestion ? `【教师策略】${input.sections.strategySuggestion.content}` : "",
      ].filter(Boolean).join("\n")
    : input.studentContext.trim();
  return sanitizeFeedbackPromptText([
    input.sessionCode
      ? `【本次生成边界】课次：${input.sessionCode}${input.studentId ? `；学生ID：${input.studentId}` : ""}。以下课堂信息、评价、助教记录、家长沟通和 PDF 证据统一作为本次背景；不得使用其他课次或其他学生的材料。`
      : "",
    selectedSections,
    assessmentEvidencePrompt(input.assessmentEvidence),
    privateFeedbackTemplatePrompt(input.lessonMaterial, input.assessmentEvidence),
    lessonMaterialPrompt(input.lessonMaterial),
    `【证据使用顺序】
1. 个人出门测报告、已确认的本课评价、考勤、事件和助教备注必须同时符合上述课次与学生身份，才属于该生证据。
2. 学期对照只描述最近两次相对个人常态和同期班均的位置，不得改写成排名。
3. 仅使用上方已确认事实；不得根据未提供的家校沟通、内部观察、风险或续班信息补充内容。
4. 课程公共材料和统一出门测说明只能描述全班学习内容、考查范围与统一建议，不得据此断言该生掌握或失误。
5. 多项证据冲突或依据不足时必须保守表达，并交给人工确认。
6. “教师策略”是内部处理方向，不得直接写入家长文本，除非它本身已由明确课堂证据支持。`,
  ].filter(Boolean).join("\n\n"));
}

function cleanJsonText(value: string) {
  let text = value.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function parseReviewPayload(value: string): ReviewPayload {
  const parsed = JSON.parse(cleanJsonText(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("审核模型未返回 JSON 对象");
  }
  return parsed as ReviewPayload;
}

function normalizeIssues(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object" && "message" in item && typeof item.message === "string") {
      return item.message.trim();
    }
    return "";
  }).filter(Boolean))].slice(0, 8);
}

function normalizeVerdict(value: unknown) {
  const verdict = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["pass", "passed", "通过"].includes(verdict)) return "passed" as const;
  if (["revise", "revised", "修订", "已修订"].includes(verdict)) return "revised" as const;
  return "needs_review" as const;
}

function isJsonModeUnsupported(error: unknown) {
  const candidate = error as { status?: number; message?: string };
  return [400, 404, 422].includes(candidate?.status ?? 0)
    && /response[_ -]?format|json[_ -]?object|json mode/i.test(candidate?.message || "");
}

function isReasoningUnsupported(error: unknown) {
  const candidate = error as { status?: number; message?: string };
  return [400, 404, 422].includes(candidate?.status ?? 0)
    && /reasoning[_ -]?effort|thinking/i.test(candidate?.message || "");
}

function withoutReasoning<T extends Record<string, unknown>>(body: T) {
  const { reasoning_effort, ...rest } = body;
  void reasoning_effort;
  return rest;
}

async function createReviewCompletion(
  client: LLMClient,
  model: string,
  prompt: string,
  signal?: AbortSignal,
  options: { disableReasoning?: boolean; profileId?: string } = {},
) {
  throwIfAborted(signal);
  // Review 阶段需要更大 token 预算：推理模型（如 deepseek-v4-pro）的 reasoning_content
  // 会占用 max_tokens 配额，2048 不够写出完整 JSON，导致 finish_reason=length 被截断。
  const configured = getLLMCompletionOptions("feedbackReview", FEEDBACK_REVIEW_MAX_TOKENS, true, options.profileId);
  // “不传 reasoning_effort”并不等于关闭推理：部分 OpenAI 兼容模型
  // （例如 Qwen）会回到原生 thinking 默认值。重试时必须显式传 none。
  const reasoningEffort = options.disableReasoning ? "none" as const : configured.reasoning_effort;
  const baseBody = {
    model,
    messages: [{ role: "user" as const, content: prompt }],
    temperature: 0,
    max_tokens: configured.max_tokens,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
  try {
    const body = {
      ...baseBody,
      response_format: { type: "json_object" as const },
    };
    return signal
      ? await client.chat.completions.create(body, { signal })
      : await client.chat.completions.create(body);
  } catch (error) {
    if (!isJsonModeUnsupported(error) && !isReasoningUnsupported(error)) throw error;
    // 降级：去掉 response_format 再试；reasoning_effort 保留以限制推理长度。
    const fallbackBody = isReasoningUnsupported(error) ? withoutReasoning(baseBody) : baseBody;
    return signal
      ? client.chat.completions.create(fallbackBody, { signal })
      : client.chat.completions.create(fallbackBody);
  }
}

async function createRoutineCompletion(
  client: LLMClient,
  model: string,
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal,
  profileId?: string,
) {
  const configured = getLLMCompletionOptions("feedbackReview", maxTokens, false, profileId);
  const baseBody = {
    model,
    messages: [{ role: "user" as const, content: prompt }],
    temperature: 0.2,
    ...configured,
    // 配置中的 maxTokens 是常规调用的偏好，不应让一次 length 截断的
    // 恢复路径再次回到更小上限。
    max_tokens: Math.max(configured.max_tokens, maxTokens),
  };
  try {
    const body = { ...baseBody, response_format: { type: "json_object" as const } };
    return signal
      ? await client.chat.completions.create(body, { signal })
      : await client.chat.completions.create(body);
  } catch (error) {
    if (!isJsonModeUnsupported(error) && !isReasoningUnsupported(error)) throw error;
    const fallbackBody = isReasoningUnsupported(error) ? withoutReasoning(baseBody) : baseBody;
    return signal
      ? client.chat.completions.create(fallbackBody, { signal })
      : client.chat.completions.create(fallbackBody);
  }
}

async function generateDraft(
  client: LLMClient,
  model: string,
  prompt: string,
  signal?: AbortSignal,
  profileId?: string,
  responseMode: "text" | "json" = "text",
) {
  for (let attempt = 1; attempt <= FEEDBACK_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const requestedMaxTokens = attempt === 1
      ? FEEDBACK_DRAFT_INITIAL_MAX_TOKENS
      : FEEDBACK_DRAFT_RETRY_MAX_TOKENS;
    const configured = getLLMCompletionOptions("feedbackDraft", requestedMaxTokens, false, profileId);
    const reasoningEffort = attempt > 1
      ? "none" as const
      : configured.reasoning_effort ?? "none" as const;
    const baseBody = {
      model,
      messages: [{ role: "user" as const, content: prompt }],
      temperature: responseMode === "json" ? 0 : 0.5,
      max_tokens: Math.max(configured.max_tokens, requestedMaxTokens),
      reasoning_effort: reasoningEffort,
    };
    const body = responseMode === "json"
      ? { ...baseBody, response_format: { type: "json_object" as const } }
      : baseBody;
    let response;
    try {
      response = signal
        ? await client.chat.completions.create(body, { signal })
        : await client.chat.completions.create(body);
    } catch (error) {
      if (!isReasoningUnsupported(error) && !isJsonModeUnsupported(error)) throw error;
      const fallbackBody = isJsonModeUnsupported(error)
        ? baseBody
        : withoutReasoning(body);
      response = signal
        ? await client.chat.completions.create(fallbackBody, { signal })
        : await client.chat.completions.create(fallbackBody);
    }
    if (isLengthTruncated(response)) continue;
    const content = response.choices[0]?.message?.content?.trim();
    if (content) return content;
  }
  throw new Error("LLM 返回空反馈内容，请重试");
}

function isLengthTruncated(response: { choices?: Array<{ finish_reason?: string | null }> }): boolean {
  return response.choices?.[0]?.finish_reason === "length";
}

interface AssessmentStructureReference {
  totalQuestions: number;
  knowledgePoints: Array<{ name: string; questionCount: number }>;
  similarPracticeCount: number;
}

function representativeAssessmentStructure(
  evidenceByStudent: Record<string, StudentAssessmentEvidence>,
): AssessmentStructureReference | null {
  const candidates = Object.values(evidenceByStudent)
    .map((evidence) => ({
      totalQuestions: evidence.totalQuestions,
      knowledgePoints: evidence.knowledgePoints.map(({ name, questionCount }) => ({ name, questionCount })),
      similarPracticeCount: evidence.similarPracticeCount,
    }))
    .sort((left, right) => (
      right.knowledgePoints.length - left.knowledgePoints.length
      || right.totalQuestions - left.totalQuestions
      || JSON.stringify(left).localeCompare(JSON.stringify(right))
    ));
  return candidates[0] ?? null;
}

function lessonSummaryFallback(
  material: LessonFeedbackMaterial,
  assessmentStructure: AssessmentStructureReference | null,
) {
  return [
    fallbackLessonSummary(material),
    assessmentStructure
      ? `代表性出门测结构：共${assessmentStructure.totalQuestions}题；涉及${
        assessmentStructure.knowledgePoints
          .map((item) => `${item.name}${item.questionCount ? `（${item.questionCount}题）` : ""}`)
          .join("、") || "未提取知识点"
      }${assessmentStructure.similarPracticeCount ? `；附${assessmentStructure.similarPracticeCount}道相似练习` : ""}。`
      : "",
  ].filter(Boolean).join("\n").slice(0, 2000);
}

export async function summarizeLessonMaterial(input: {
  material: LessonFeedbackMaterial;
  assessmentEvidence?: Record<string, StudentAssessmentEvidence>;
  client: LLMClient;
  model: string;
  signal?: AbortSignal;
}): Promise<LessonFeedbackMaterial> {
  const assessmentStructure = representativeAssessmentStructure(input.assessmentEvidence ?? {});
  if (!lessonMaterialHasContent(input.material) && !assessmentStructure) return input.material;

  const source = {
    lesson: lessonMaterialSummarySource(input.material),
    // 这里只借用一份已确认 PDF 的课程/母题结构。学生身份、分数、答案、
    // 正误和错题结论都不进入班级摘要。
    representativeAssessmentStructure: assessmentStructure,
  };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex");
  if (
    input.material.lessonSummary?.trim()
    && input.material.lessonSummarySourceHash === sourceHash
  ) {
    return input.material;
  }

  const prompt = sanitizeFeedbackPromptText(`你是化学教师的课程材料整理助手。请先建立对本班本节课的初步课程认识，供随后逐个学生生成反馈时复用。

要求：
1. 将课程草稿整理成一段 120—350 字的中文课程摘要，覆盖实际讲授内容、知识组织、重点方法，以及作业或统一考查结构；不要机械截成两项。
2. “代表性出门测结构”来自本班一名学生的已确认报告，但已去除个人表现。它只用于补充母题、知识点覆盖与考查结构，不能推断任何学生的掌握、错误、分数或能力。
3. 不写称呼，不出现“XX妈妈”“某某家长”等占位符，不写某个孩子，不照抄群反馈寒暄。
4. 不添加输入中没有的课程内容。课程草稿与出门测结构冲突时，只写能够共同确认的范围。
5. 只返回 JSON：{"summary":"..."}。

课程整理输入：
${JSON.stringify(source)}`);

  const budgets = [LESSON_SUMMARY_INITIAL_MAX_TOKENS, LESSON_SUMMARY_RETRY_MAX_TOKENS];
  for (const maxTokens of budgets) {
    throwIfAborted(input.signal);
    try {
      const response = await createRoutineCompletion(
        input.client,
        input.model,
        prompt,
        maxTokens,
        input.signal,
      );
      if (isLengthTruncated(response)) continue;
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) continue;
      const payload = JSON.parse(cleanJsonText(content)) as { summary?: unknown };
      const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
      if (summary.length < 20 || summary.length > 2000 || containsRecipientPlaceholder(summary)) continue;
      return {
        ...input.material,
        lessonSummary: summary,
        lessonSummarySourceHash: sourceHash,
        lessonSummaryStatus: "model",
      };
    } catch (error) {
      throwIfAborted(input.signal);
      if (maxTokens === LESSON_SUMMARY_RETRY_MAX_TOKENS) {
        console.warn(
          "[feedback] lesson summary fell back to deterministic material:",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
  }

  return {
    ...input.material,
    lessonSummary: lessonSummaryFallback(input.material, assessmentStructure),
    lessonSummarySourceHash: sourceHash,
    lessonSummaryStatus: "fallback",
  };
}

async function reviewDraft(client: LLMClient, model: string, prompt: string, signal?: AbortSignal, profileId?: string) {
  // 第 1 次：reasoning_effort=low + json_object，max_tokens=4096
  // 第 2 次：若第 1 次因 length 截断或 JSON 解析失败，禁用推理（reasoning_effort=none）
  //          以彻底消除 reasoning_content 对 max_tokens 的占用
  for (let attempt = 1; attempt <= FEEDBACK_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await createReviewCompletion(
        client, model, prompt, signal,
        { disableReasoning: attempt > 1, profileId },
      );
      if (isLengthTruncated(response)) {
        // 截断意味着推理吃光了 token 预算；下一次禁用推理。
        continue;
      }
      const content = response.choices[0]?.message?.content?.trim();
      if (content) return parseReviewPayload(content);
    } catch {
      throwIfAborted(signal);
      // Retry once with reasoning disabled before requiring manual review.
    }
  }
  return null;
}

export async function generateReviewedFeedback(
  input: GenerateReviewedFeedbackInput,
): Promise<ReviewedFeedback> {
  const draftFeedback = await generateFeedbackDraft({
    studentName: input.studentName,
    promptContext: input.promptContext,
    style: input.style,
    length: input.length,
    profileId: input.profileId,
    client: input.draftClient,
    model: input.draftModel,
    signal: input.signal,
  });
  return reviewFeedbackDraft({
    studentName: input.studentName,
    promptContext: input.promptContext,
    forbiddenStudentNames: input.forbiddenStudentNames,
    style: input.style,
    length: input.length,
    profileId: input.profileId,
    draftFeedback,
    client: input.reviewClient,
    model: input.reviewModel,
    signal: input.signal,
  });
}

/** A lightweight one-pass finalizer for routine students. */
export async function generateRoutineFeedback(input: GenerateRoutineFeedbackInput): Promise<ReviewedFeedback> {
  const forbiddenNames = [...new Set((input.forbiddenStudentNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name && name !== input.studentName))];
  const prompt = `你是 Student Track 的课后反馈模型。请仅根据以下确定性背景，写一条可直接发给${input.studentName}家长的短反馈。

${input.promptContext}

规则：
1. ${feedbackLengthRequirement(input.length)}，写成自然、连贯的微信短句；只围绕本次最值得说的一件表现，带上具体依据，并用一句有边界的解释说明它为什么值得家长知道。
2. 语气要像老师认真看过孩子当堂表现后亲自发出的简短消息：事实之后可以自然表达一次具体的肯定、关照或稳妥的收束，让家长感到孩子被看见；不得用空泛夸奖代替事实，也不得写成冷冰冰的评分结论。
3. 本次表达风格：${feedbackStyleInstruction(input.style)}风格只改变表达，不得改变事实、证据、问题强度、教师内部研判或安全规则。
4. 默认不布置建议或任务。只有背景明确要求家长配合时，才加一句最小必要提醒；没有明确前后证据，不得写“越来越好、明显提升、习惯形成、从不会到会”。
5. 家校沟通只用于确定表达重点，不能替代本课事实；不要提及内部标签、风险、观察、班均或其他学生。
6. 公共课程材料只可说明本节主题，不可当作学生个人掌握证据。不要套用“整体表现优异、值得肯定、继续保持、订正巩固”等空泛模板；具体表现得到的真诚肯定可以保留。
7. 不使用任何家长称呼、寒暄或模板占位符，例如“XX妈妈”“某某家长”“家长您好”；直接从该生本次表现开始。
8. 只返回合法 JSON：{"verdict":"pass|needs_review","feedback":"最终文本","issues":["简短原因"]}。证据不足时返回 needs_review，不要补写。`;
  let payload: ReviewPayload | null = null;
  let failureReason = "";
  for (let attempt = 1; attempt <= FEEDBACK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const maxTokens = attempt === 1
        ? FEEDBACK_ROUTINE_INITIAL_MAX_TOKENS
        : FEEDBACK_ROUTINE_RETRY_MAX_TOKENS;
      const response = await createRoutineCompletion(input.client, input.model, prompt, maxTokens, input.signal, input.profileId);
      if (isLengthTruncated(response)) {
        failureReason = attempt < FEEDBACK_MAX_ATTEMPTS
          ? "常规反馈模型的推理输出达到长度上限，已自动提高输出预算重试"
          : "常规反馈模型的推理输出达到长度上限，未生成最终文本";
        continue;
      }
      const content = response.choices[0]?.message?.content?.trim();
      if (content) {
        try {
          payload = parseReviewPayload(content);
          break;
        } catch {
          failureReason = "常规反馈模型返回的 JSON 无法解析";
        }
      } else {
        failureReason = "常规反馈模型未返回最终文本";
      }
    } catch {
      throwIfAborted(input.signal);
      failureReason = "常规反馈模型请求失败，请检查模型设置后重试";
    }
  }
  if (!payload) {
    return {
      draftFeedback: "",
      feedback: "",
      reviewStatus: "needs_review",
      reviewIssues: [failureReason || "常规反馈模型未返回合法结果，请人工填写"],
    };
  }
  let feedback = typeof payload.feedback === "string" ? payload.feedback.trim() : "";
  let reviewStatus = normalizeVerdict(payload.verdict);
  const reviewIssues = normalizeIssues(payload.issues);
  if (!feedback) {
    reviewStatus = "needs_review";
    reviewIssues.push("常规反馈模型没有返回可发送的最终文本");
  }
  if (forbiddenNames.some((name) => feedback.includes(name))) {
    feedback = "";
    reviewStatus = "needs_review";
    reviewIssues.push("反馈中出现了其他学生姓名");
  }
  if (containsRecipientPlaceholder(feedback)) {
    feedback = "";
    reviewStatus = "needs_review";
    reviewIssues.push("反馈中出现了家长称呼占位符");
  }
  return {
    draftFeedback: "",
    feedback,
    reviewStatus,
    reviewIssues: [...new Set(reviewIssues)],
  };
}

export async function generateFeedbackDraft(input: FeedbackDraftInput) {
  const draftPrompt = `你是 Student Track 的内部反馈分析模型。请严格依据以下确定性背景，为${input.studentName}生成一份仅供后续成稿模型使用的内部分析草稿，不要写成给家长直接发送的话术。

${input.promptContext}

分析要求：
1. 不要复述整份课程母版。只提炼最值得告诉家长的一项表现或问题；只有明确需要时才提出一项最小动作。
2. 最近两次只与个人本学期整体和对应课次班均对照；不得做“前两次 vs 最近两次”，也不得改写成“比学期初、比以前、一开始时更好”，不得写排名。
3. 个人 PDF 中的题数、正确率、知识点和答案是本次客观证据；单道错题不得扩张成长期能力判断。
4. 从历史评价、助教备注和事件中寻找真实的努力、习惯或方法信号，例如连续主动回答、开始记录步骤、愿意订正、由提示后完成到独立完成。一次行为只能写“本次出现”，重复行为可写“最近连续出现”或“正在形成”；没有方向性对照时不得写“越来越、明显提升、比以前更”。
5. 只有同一能力的前后证据或明确 T1/T2/T3 结果才能写“从不会到会”“已经掌握”“形成习惯”；否则只能描述本次结果和正在出现的积极信号。
6. 家校沟通已按实际发生时间由近到远排列。优先使用最接近本课且尚未解决的关切或承诺；较旧内容只作背景，若已被更新沟通取代则忽略。若家长曾担心成绩、难度、信心、方法或作业，应寻找本次可以回应该关切的证据；无相关证据或沟通只是收悉、请假、排课时，不要强行使用。
7. 所有背景都要区分“事实”“有边界的成长解读”和“建议”。成长解读要帮助家长理解孩子正在吸收什么、哪种方法正在建立，但不能拔高或许诺结果。
8. 默认不写课后动作。只有背景明确需要家长配合或已有具体教师承诺时，才写一项可执行动作；不要只写“订正巩固”“加强复习”。
9. 只分析该生本人，不比较、不提其他学生姓名，不补充背景中不存在的成绩、考勤、事件或家校结论。
10. 控制在 100–180 字，可分点；不要使用家长称呼、寒暄或可直接发送的结尾。最终家长话术将由下一阶段生成，目标长度为${feedbackLengthRequirement(input.length)}，表达风格为：${feedbackStyleInstruction(input.style)}`;
  return generateDraft(input.client, input.model, draftPrompt, input.signal, input.profileId);
}

export async function reviewFeedbackDraft(input: FeedbackReviewInput): Promise<ReviewedFeedback> {
  const draftFeedback = input.draftFeedback;
  const forbiddenNames = [...new Set((input.forbiddenStudentNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name && name !== input.studentName))];
  const reviewPrompt = `你是 Student Track 的反馈成稿与审核模型。请先逐项对照“确定性反馈背景”复核内部分析草稿，再把可靠内容改写成可以直接发给家长的话术。内部分析只是辅助材料，不是新的事实来源。

确定性反馈背景：
${input.promptContext}

内部分析草稿（仅供参考，不得原样发送）：
${draftFeedback}

成稿与审核规则：
1. 学生身份、本次表现、近期趋势、考勤、事件和家校沟通都必须能在确定性背景中找到依据；分析草稿与背景冲突时以背景为准。
2. 写成老师课后单独发给家长的微信，不写成学习报告。用2—4个自然短句，只突出一个核心结论；不要求同时表扬、分析问题和布置动作。
3. 家长读完应得到三种真实感受：老师确实观察到了我的孩子；孩子的努力和变化被看见；当前问题具体且下一步可控。情绪价值来自降低不确定感和看见真实努力，不来自空泛夸奖、制造焦虑或承诺提分。
4. 不使用 A/B/C/D 等系统字段代号，不比较或提到其他学生，不把建议写成已经发生的事实。
5. 公共课程材料不得被写成个体掌握结论；出门测统一说明中的“有错误、表现好”等模板判断不得作为证据。
6. 不输出排名；允许说“最近两次处在个人本学期较好水平”或“本次与同期整体接近”，但不得将全学期常态对照改写为“比学期初、比以前更好”，不要制造竞争和焦虑。
7. 不要照抄或近义改写群反馈，不要罗列完整课堂内容。课程主题最多用半句话交代，除非它是理解个体错题所必需的背景。
8. 禁用“整体表现优异”“值得肯定”“后续请关注”“订正巩固”“巩固学习效果”“如有疑问可随时联系老师”等成套 AI 话术。可以直接、口语化，但不要油腻或夸张。
9. 只有明确的前后证据才可写“从不会到会”“已经掌握”“越来越”“明显提升”“习惯已经形成”。若证据只是本次答题和重复出现的积极事件，应写“这次已经能……”“最近几节课都……”“这种做法正在慢慢稳定下来”。
10. 家校沟通按实际发生时间由近到远提供。优先回应最近且仍有效的学习关切或教师承诺；旧内容与新内容冲突时以新内容为准。可用本次证据自然回应，例如“您之前提到他觉得开始变难，这次……”。与学习无关的收悉、请假、排课和寒暄不得进入反馈。
11. 只有背景明确需要补救且给出题号或材料时，才写一项具体任务；不得凭空编造题目内容。普通情况可直接结束，不强行布置作业。
12. 最终 feedback 应满足${feedbackLengthRequirement(input.length)}；本次表达风格为：${feedbackStyleInstruction(input.style)}风格只改变表达，不得改变事实、证据、问题强度、内部研判或安全规则。文本应具体、连贯，适合直接发送；不要标题、项目符号或内部分析措辞。不得使用任何家长称呼、寒暄或模板占位符，例如“XX妈妈”“某某家长”“家长您好”，直接从该生表现开始。
13. 分析可靠且已成功成稿时 verdict="pass"；需要删改分析中的不可靠内容但仍能安全成稿时 verdict="revise"；无法可靠成稿时 verdict="needs_review"。
14. 无论 pass 还是 revise 都必须返回完整最终 feedback；needs_review 可返回一份供教师修改的保守文本，并在 issues 中说明原因。
15. 只返回合法 JSON：{"verdict":"pass|revise|needs_review","feedback":"最终文本","issues":["简短原因"]}。`;
  const reviewed = await reviewDraft(input.client, input.model, reviewPrompt, input.signal, input.profileId);
  if (!reviewed) {
    return {
      draftFeedback,
      feedback: "",
      reviewStatus: "needs_review",
      reviewIssues: ["成稿模型连续两次未返回合法结果，内部分析未作为家长话术使用"],
    };
  }

  let reviewStatus = normalizeVerdict(reviewed.verdict);
  const reviewIssues = normalizeIssues(reviewed.issues);
  const revisedFeedback = typeof reviewed.feedback === "string" ? reviewed.feedback.trim() : "";
  let feedback = revisedFeedback;
  if (!revisedFeedback) {
    reviewStatus = "needs_review";
    reviewIssues.push("成稿模型没有返回可发送的最终文本");
  }
  if (reviewStatus === "needs_review" && reviewIssues.length === 0) {
    reviewIssues.push("审核模型认为该反馈需要人工确认");
  }
  const mentionedOtherStudent = forbiddenNames.find((name) => feedback.includes(name));
  if (mentionedOtherStudent) {
    reviewStatus = "needs_review";
    reviewIssues.push("反馈中出现了其他学生姓名");
    feedback = "";
  }
  if (containsRecipientPlaceholder(feedback)) {
    reviewStatus = "needs_review";
    reviewIssues.push("反馈中出现了家长称呼占位符");
    feedback = "";
  }
  return {
    draftFeedback,
    feedback,
    reviewStatus,
    reviewIssues: [...new Set(reviewIssues)],
  };
}

export interface FeedbackPlanGenerationInput {
  studentName: string;
  planType: FeedbackPlanType;
  evidenceBundle: FeedbackEvidenceBundle;
  style: FeedbackStyle;
  length: FeedbackLength;
  draftClient: LLMClient;
  draftModel: string;
  reviewClient: LLMClient;
  reviewModel: string;
  profileId?: string;
  existingTaskIds?: Set<string>;
  signal?: AbortSignal;
}

function parseComposition(value: string, stage: "draft" | "review" | "correction") {
  const stageLabel = stage === "draft" ? "组装" : stage === "review" ? "审核" : "纠错";
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanJsonText(value));
  } catch {
    throw new ApiError(`反馈${stageLabel}模型未返回合法 JSON，本条未保存；请重试`, 502, "llm_schema_invalid", true);
  }
  // Parent action is optional and must fail conservatively. When a compatible
  // provider omits the nullable field or returns an incomplete action object,
  // downgrade the proposal to "no parent action". The later review and hard
  // gate still remove/block any action language left in the draft text; we
  // never fabricate a family task to make the schema pass.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const candidate = parsed as Record<string, unknown>;
    const parentAction = FeedbackCompositionPlanSchema.shape.parentAction.safeParse(candidate.parentAction);
    if (candidate.needParentAction !== true || !parentAction.success || parentAction.data === null) {
      parsed = { ...candidate, needParentAction: false, parentAction: null };
    }
  }
  const result = FeedbackCompositionPlanSchema.safeParse(parsed);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "root"))].slice(0, 4);
  throw new ApiError(`反馈${stageLabel}模型缺少或写错字段：${fields.join("、")}；本条未保存`, 502, "llm_schema_invalid", true);
}

function normalizeCompositionDependencies(composition: FeedbackCompositionPlan) {
  if (composition.needParentAction && composition.parentAction) return composition;
  return {
    ...composition,
    needParentAction: false,
    parentAction: null,
    closureType: composition.closureType === "home_cooperation" ? "positive_recognition" as const : composition.closureType,
    modules: composition.modules.map((module) => module.key === "parent_action"
      ? { ...module, status: "blocked" as const, reason: "没有合法家长动作，程序已禁用此模块" }
      : module),
  };
}

/**
 * Three-layer feedback generation used by FeedbackPlan. The first layer is
 * supplied by the deterministic evidence service; this function only performs
 * the structured composition draft and constrained review/polish. The caller
 * must still run the deterministic audit before approval.
 */
export async function generateFeedbackPlanComposition(input: FeedbackPlanGenerationInput) {
  const evidence = FeedbackEvidenceBundleSchema.parse(input.evidenceBundle);
  const evidenceText = JSON.stringify(evidence);
  const allowedModules = [...FEEDBACK_MODULES[input.planType]];
  const allowedClosures = [...FEEDBACK_CLOSURES_BY_TYPE[input.planType]];
  const evidenceIds = evidence.teachingEvidence.concat(evidence.communicationContext)
    .filter((item) => item.confirmed && item.kind !== "model_candidate")
    .map((item) => item.id);
  const protocolBoundary = `当前类型允许的 module key 只有：${allowedModules.join(", ")}。
当前类型允许的 closureType 只有：${allowedClosures.join(", ")}。
evidenceRefs 只能逐字使用以下证据 ID：${evidenceIds.join(", ")}。`;
  const draftPrompt = `你是 Student Track 的反馈组装模型。请只依据确定性证据包，为${input.studentName}生成结构化反馈组装方案。不要添加证据包之外的事实、教师动作、家长动作或未来承诺。

反馈类型：${input.planType}
表达偏好：长度 ${input.length}；语气与术语按 ${input.style}，但偏好不能改变事实、风险、家长动作或教师承诺边界。
确定性证据包：
${evidenceText}

结构协议（必须严格遵守）：
${protocolBoundary}

规则：
1. 只能从上面明确列出的 module key 中选择两到四个有价值的模块，不得自造、翻译或使用旧版模块名；每个 included 模块至少引用一个上面列出的证据 ID。
2. needParentAction 默认 false；家长动作只能是提醒、确认、提供条件或反馈异常。
3. teacher_intervention、teacher_support 和 intervention_outcome 必须有证据；followup_observation 必须已有任务或固定安排。
4. closureType 只能从上面列出的当前类型选项中选择；不得因为示例中出现其他结尾就使用越界值。
5. 不产生续班、销售、风险标签或内部研判；不要称呼家长。
6. draftFeedback 只是初稿，不要写标题或项目符号。

只返回 JSON：{
  "version":1,
  "closureType":"informational|positive_recognition|teacher_resolved|home_cooperation|continued_observation",
  "needParentAction":false,
  "parentAction":null,
  "modules":[{"key":"...","content":"...","evidenceRefs":["..."],"status":"included|omitted|blocked","reason":"..."}],
  "draftFeedback":"..."
}`;
  const draftRaw = await generateDraft(input.draftClient, input.draftModel, draftPrompt, input.signal, input.profileId, "json");
  let draftComposition;
  try {
    draftComposition = normalizeCompositionDependencies(parseComposition(draftRaw, "draft"));
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "llm_schema_invalid") throw error;
    const repairPrompt = `你是 Student Track 的结构修复模型。下面的反馈组装输出不是合法结构，请只做 JSON 结构修复，不新增、删除或改写其中的教学事实。

反馈类型：${input.planType}
${protocolBoundary}

无效输出：
${draftRaw.slice(0, 12000)}

请返回完整 JSON，必须包含 version=1、closureType、needParentAction、parentAction、modules、draftFeedback。parentAction 不需要时必须为 null；每个 module 必须包含 key、content、evidenceRefs、status、reason。`;
    const repairedResponse = await createReviewCompletion(input.reviewClient, input.reviewModel, repairPrompt, input.signal, { disableReasoning: true, profileId: input.profileId });
    const repairedContent = repairedResponse.choices[0]?.message?.content?.trim();
    if (!repairedContent) throw error;
    draftComposition = normalizeCompositionDependencies(parseComposition(repairedContent, "draft"));
  }
  const reviewPrompt = `你是 Student Track 的反馈审核与受限润色模型。请对照同一份确定性证据包审核组装方案，并只在证据允许的范围内润色。润色不得新增事实、家长动作、教师处理或未来承诺。

确定性证据包：
${evidenceText}

组装方案：
${JSON.stringify(draftComposition)}

结构协议（优先级高于原组装方案）：
${protocolBoundary}

审核规则：
1. 所有 included 模块必须使用当前类型允许的精确 key，并至少有一个有效 evidenceRefs；原方案中的旧版或自造 key 必须改成当前目录中的合适 key，不能原样保留。
2. 家长动作开关、教师处理、处理结果和后续观察遵守字段依赖。
3. 发现隐性承诺、内部信息或证据不足时，将对应模块标记 blocked 或 needs_review，不要替教师放行。
4. closureType 必须属于当前类型允许列表；原方案越界时必须纠正。
5. 只返回完整结构化 JSON，draftFeedback 是最终家长文本。

返回字段必须包含 version、closureType、needParentAction、parentAction、modules 和 draftFeedback；modules 使用 key、content、evidenceRefs、status、reason。`;
  const reviewedResponse = await createReviewCompletion(input.reviewClient, input.reviewModel, reviewPrompt, input.signal, { profileId: input.profileId });
  let reviewedContent = reviewedResponse.choices[0]?.message?.content?.trim();
  if (!reviewedContent) throw new Error("反馈审核模型返回空结果");
  let reviewedComposition;
  try {
    reviewedComposition = normalizeCompositionDependencies(parseComposition(reviewedContent, "review"));
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "llm_schema_invalid") throw error;
    const repairReviewPrompt = `你是 Student Track 的审核结果结构修复模型。上一份审核输出不是合法 JSON。请依据同一证据包修复结构并删除越界的家长动作或教师承诺，不新增事实。

反馈类型：${input.planType}
${protocolBoundary}

确定性证据包：
${evidenceText}

无效审核输出：
${reviewedContent.slice(0, 12000)}

只返回完整 JSON，字段必须包含 version=1、closureType、needParentAction、parentAction、modules、draftFeedback。无需家长动作时 needParentAction=false 且 parentAction=null。`;
    const repairedReview = await createReviewCompletion(input.reviewClient, input.reviewModel, repairReviewPrompt, input.signal, { disableReasoning: true, profileId: input.profileId });
    const repairedContent = repairedReview.choices[0]?.message?.content?.trim();
    if (!repairedContent) throw error;
    reviewedContent = repairedContent;
    reviewedComposition = normalizeCompositionDependencies(parseComposition(repairedContent, "review"));
  }
  let audit = createAuditSnapshot(reviewedComposition, evidence, input.existingTaskIds);
  const blocked = audit.items.filter((issue) => issue.severity === "blocked");
  if (blocked.length) {
    const correctionPrompt = `你是 Student Track 的结构纠错模型。上一版反馈未通过程序门禁，请只修正结构和越界表达，不新增任何事实或动作。

反馈类型：${input.planType}
${protocolBoundary}

确定性证据包：
${evidenceText}

上一版结果：
${JSON.stringify(reviewedComposition)}

必须修正的问题：
${blocked.map((issue) => `- ${issue.message}`).join("\n")}

只返回完整 JSON，字段为 version、closureType、needParentAction、parentAction、modules、draftFeedback。modules 必须选两到四个，且 key 和 evidenceRefs 只能取上面允许的精确值。`;
    const correctedResponse = await createReviewCompletion(input.reviewClient, input.reviewModel, correctionPrompt, input.signal, { profileId: input.profileId });
    const correctedContent = correctedResponse.choices[0]?.message?.content?.trim();
    if (correctedContent) {
      reviewedComposition = normalizeCompositionDependencies(parseComposition(correctedContent, "correction"));
      audit = createAuditSnapshot(reviewedComposition, evidence, input.existingTaskIds);
    }
  }
  const structuralCodes = new Set(["module_not_allowed", "evidence_ref_missing", "module_count_invalid", "closure_not_allowed"]);
  if (audit.items.some((issue) => issue.severity === "blocked" && structuralCodes.has(issue.code))) {
    throw new ApiError("反馈模型未遵守当前类型的模块协议，本条未保存；请重试生成", 502, "llm_schema_invalid", true);
  }
  return {
    draftComposition,
    composition: reviewedComposition,
    audit,
    reviewRaw: reviewedContent,
  };
}
