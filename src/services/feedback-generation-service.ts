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
  containsStudentDirectedAddress,
  sanitizeFeedbackPromptText,
  stripFeedbackInternalBoundary,
} from "@/lib/feedback-text-safety";
import { replaceFeedbackDatesWithRelativeLabels, relativeFeedbackDateLabel } from "@/lib/feedback-time";
import {
  FEEDBACK_CLOSURES_BY_TYPE,
  FEEDBACK_MODULES,
  FeedbackCompositionPlanSchema,
  FeedbackEvidenceBundleSchema,
  sanitizeFeedbackComposition,
  sanitizeFeedbackEvidenceBundle,
  type FeedbackCompositionPlan,
  type FeedbackEvidenceBundle,
  type FeedbackPlanType,
  type FeedbackGenerationMode,
  type FeedbackGenerationPreferences,
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

const PARENT_RECIPIENT_PROTOCOL = `【收件人协议（硬规则）】默认收件人是家长。全文站在老师对家长说话的位置，谈到学生时使用姓名、“孩子”或第三人称；不得直接对学生使用“你/你们”或学生式称呼，也不得自行切换收件人。`;

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
  referenceDate?: string;
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
  referenceDate?: string;
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
  referenceDate?: string;
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
  referenceDate?: string;
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
  const prompt = [
    input.sessionCode
      ? `【本次生成边界】课次：${input.sessionCode}${input.studentId ? `；学生ID：${input.studentId}` : ""}。以下课堂信息、评价、助教记录、家长沟通和 PDF 证据统一作为本次背景；不得使用其他课次或其他学生的材料。`
      : "",
    selectedSections,
    assessmentEvidencePrompt(input.assessmentEvidence),
    privateFeedbackTemplatePrompt(input.lessonMaterial, input.assessmentEvidence),
    lessonMaterialPrompt(input.lessonMaterial),
    `【时间语义协议】本次目标课次作为“今天”的时间锚点。证据中的时间标签由程序按实际发生时间转换为今天、昨天、前天或更早；不要把更早的证据改写成本次发生，也不要在成稿中补写或重复精确日期。需要表达先后时使用相对时间；跨日沟通保持时间范围，不压成某一天。

【证据使用顺序】
1. 个人出门测报告、已确认的本课评价、考勤、事件和助教备注必须同时符合上述课次与学生身份，才属于该生证据。
2. 学期对照只描述最近两次相对个人常态和同期班均的位置，不得改写成排名。
3. 仅使用上方已确认事实；不得根据未提供的家校沟通、内部观察、风险或续班信息补充内容。
4. 课程公共材料和统一出门测说明只能描述全班学习内容、考查范围与统一建议，不得据此断言该生掌握或失误。
5. 多项证据冲突或依据不足时必须保守表达，并交给人工确认。
6. “教师策略”是内部处理方向，不得直接写入家长文本，除非它本身已由明确课堂证据支持。`,
  ].filter(Boolean).join("\n\n");
  return sanitizeFeedbackPromptText(replaceFeedbackDatesWithRelativeLabels(prompt, input.referenceDate));
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
    referenceDate: input.referenceDate,
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
    referenceDate: input.referenceDate,
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
  const promptContext = replaceFeedbackDatesWithRelativeLabels(input.promptContext, input.referenceDate);
  const prompt = `你是 Student Track 的课后反馈模型。请仅根据以下确定性背景，写一条可直接发给${input.studentName}家长的短反馈。

${promptContext}

【时间语义协议】本次目标课次作为“今天”的时间锚点。使用今天、昨天、前天或更早描述先后；不要把历史证据归入今天，也不要在成稿中附带精确日期。

${PARENT_RECIPIENT_PROTOCOL}

规则：
1. ${feedbackLengthRequirement(input.length)}，写成自然、连贯的微信消息。围绕本次最值得说的一条主线展开，可以带上一到两个相关判断，让家长知道孩子哪些地方学得还可以、哪里还没有消化，以及这些表现为什么值得注意。
2. 教师判断应多于数据罗列。只保留家长容易理解且能支撑判断的标志性数据，例如总正确率或有明确可比基础的变化；题目明细、过程分和重复数字尽量转化为对知识点、方法或能力表现的解释。
3. 可以连接多条证据，判断它们共同反映了什么。只有跨课次、可比较的重复证据才能说某个能力问题正在延续或已经连成一条线；单次证据只解释本次表现。
4. 本次表达风格：${feedbackStyleInstruction(input.style)}风格只改变表达，不得改变事实、证据、问题强度、教师内部研判或安全规则。
5. 默认不布置建议或任务。只有判断需要的时候可以这样做；没有前后证据，不得写“越来越好、明显提升、习惯形成、从不会到会”。
6. 像老师自然说话一样组织内容，不套“先说表现、再报数据、最后提建议”的固定顺序，也不写成编号报告。可以从判断、课堂瞬间或家长最关心的变化自然起笔。
7. 公共课程材料只可说明本节主题。具体表现得到的真诚肯定可以保留。
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
  let feedback = typeof payload.feedback === "string"
    ? replaceFeedbackDatesWithRelativeLabels(stripFeedbackInternalBoundary(payload.feedback.trim()), input.referenceDate)
    : "";
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
  if (containsStudentDirectedAddress(feedback)) {
    feedback = "";
    reviewStatus = "needs_review";
    reviewIssues.push("家长反馈错误地直接面向学生");
  }
  return {
    draftFeedback: "",
    feedback,
    reviewStatus,
    reviewIssues: [...new Set(reviewIssues)],
  };
}

export async function generateFeedbackDraft(input: FeedbackDraftInput) {
  const promptContext = replaceFeedbackDatesWithRelativeLabels(input.promptContext, input.referenceDate);
  const draftPrompt = `你是 Student Track 的内部反馈分析模型。请严格依据以下确定性背景，为${input.studentName}生成一份仅供后续成稿模型使用的内部分析草稿，不要写成给家长直接发送的话术。

${promptContext}

【时间语义协议】本次目标课次作为“今天”的时间锚点。使用今天、昨天、前天或更早描述先后；不要把历史证据归入今天，也不要在成稿中附带精确日期。

分析要求：
1. 以确定性背景为事实底座，不补充其中不存在的成绩、考勤、事件、沟通、教师动作或家庭情况。
2. 不必只复述证据。优先形成教师判断：从题目和课堂过程看，哪些知识已经能够使用，哪里只是暂时会做但还没有真正消化，问题更接近概念理解、条件识别、步骤习惯还是迁移能力。
3. 把多次课堂、测评和沟通中指向同一能力的证据连接起来。只有存在跨时间的重复表现时，才能判断某个长期被忽略的能力已经形成连续问题；只有单次证据时，就停留在本次判断。
4. 规划正文信息时减少原始数据暴露。优先选择总正确率、今天相对昨天、今天相对个人以往等家长能直接理解且确有可比基础的标志性数据；其余题目明细、分项分数和重复数字用于支撑分析，不必逐项展示。
5. 合理联想必须能回到现有证据。把“已经发生的事实”“基于证据的解释”“可选建议”区分清楚；原因不确定时可以提出可能性，但不要写成确定事实，也不要从单次表现推断人格或长期能力。
6. 初稿不是摘要，也不是最终发送文本，不以简短和信息压缩为目标。优先把证据之间的联系、教学判断和不同写作角度写充分，删减与最终取舍交给后续审核和老师。
7. 家校沟通已按实际发生时间由近到远排列。优先使用较新且仍有效的关切或承诺；旧内容被新沟通取代时忽略。没有相关证据时不强行回应。
8. 只有现有证据确实支持时才提出家长动作、教师承诺或具体课后任务；不要把建议写成已经发生的事实。
9. 只分析该生本人。可以从最重要的判断、一个课堂瞬间或家长关心的问题自然展开，不预设“事实—分析—建议”的固定顺序；证据较多时自然分句，允许完整主语、连接词、适度重复、自然省略和不完全对称的句式。表达风格参考：${feedbackStyleInstruction(input.style)}`;
  const draft = await generateDraft(input.client, input.model, draftPrompt, input.signal, input.profileId);
  return replaceFeedbackDatesWithRelativeLabels(stripFeedbackInternalBoundary(draft), input.referenceDate);
}

export async function reviewFeedbackDraft(input: FeedbackReviewInput): Promise<ReviewedFeedback> {
  const draftFeedback = stripFeedbackInternalBoundary(input.draftFeedback);
  const promptContext = replaceFeedbackDatesWithRelativeLabels(input.promptContext, input.referenceDate);
  const forbiddenNames = [...new Set((input.forbiddenStudentNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name && name !== input.studentName))];
  const reviewPrompt = `你是 Student Track 的反馈成稿与审核模型。请先逐项对照“确定性反馈背景”复核内部分析草稿，再把可靠内容改写成可以直接发给家长的话术。内部分析只是辅助材料，不是新的事实来源。

确定性反馈背景：
${promptContext}

【时间语义协议】本次目标课次作为“今天”的时间锚点。优先使用今天、昨天、前天或更早描述先后；不要把历史证据归入今天，也不要在成稿中附带精确日期。

内部分析草稿（仅供参考，不得原样发送）：
${draftFeedback}

${PARENT_RECIPIENT_PROTOCOL}

成稿与审核规则：
1. 逐项核对事实底座。分析草稿与背景冲突时以背景为准；没有依据的事实、确定性过高的结论和越界承诺需要修正。
2. 让教师判断成为正文主体。用题目与课堂证据说明孩子哪里学得还可以、哪里没有真正消化、背后更像是哪一种知识或能力问题；有跨时间证据时，可以把反复出现的能力表现连成一条清楚的线。
3. 数据只承担锚定判断的作用。优先保留总正确率和有明确可比基础的变化；分项分数、题号和重复数字尽量消化成自然判断，不把证据包改写成数据清单。不得为了减少数字而丢掉证据所支持的重要结论。
4. 不要因为内容包含分析或联想就自动删掉。只要能由现有证据合理支持，应保留它的教学价值；确定性过高时优先改成适当的可能性表达，而不是删除整段。
5. 这是供老师继续审核和删改的可发送草稿。除明显重复、事实冲突或安全越界外，不要为了追求短、稳或统一风格主动删掉有依据的内容；最终取舍交给老师。
6. 可以重新组织证据并补充自然过渡，使文本像老师课后单独发给家长的微信。不要套固定段式，也不要按“先……再……最后……”机械推进。长句可以拆开，缺少主语时可以补回主语，也可以保留适度冗余、自然停顿和变化的语序。${feedbackLengthRequirement(input.length)}只作为柔性参考，不要求为此压缩内容；表达风格为：${feedbackStyleInstruction(input.style)}。
7. 不使用系统字段代号，不比较或提到其他学生，不输出排名。公共课程材料和统一模板不能替代该生个人证据；建议不能写成已经发生的事实。
8. 家校沟通优先使用较新且仍有效的学习关切或教师承诺。具体任务、教师未来动作和家庭配合必须有背景依据；不确定时放入 issues 交给老师判断。
9. 分析可靠且已成功成稿时 verdict="pass"；修正了不可靠内容时 verdict="revise"；仍有无法确认的事实或边界时 verdict="needs_review"。无论哪种 verdict，都返回尽可能完整的 feedback，供老师继续修改。
10. 只返回合法 JSON：{"verdict":"pass|revise|needs_review","feedback":"最终文本","issues":["简短原因"]}。`;
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
  const revisedFeedback = typeof reviewed.feedback === "string"
    ? replaceFeedbackDatesWithRelativeLabels(stripFeedbackInternalBoundary(reviewed.feedback.trim()), input.referenceDate)
    : "";
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
  if (containsStudentDirectedAddress(feedback)) {
    reviewStatus = "needs_review";
    reviewIssues.push("家长反馈错误地直接面向学生");
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
  outputRequirement: string;
  evidenceBundle: FeedbackEvidenceBundle;
  style: FeedbackStyle;
  length: FeedbackLength;
  draftClient: LLMClient;
  draftModel: string;
  reviewClient: LLMClient;
  reviewModel: string;
  generationMode?: FeedbackGenerationMode;
  generationPreferences?: FeedbackGenerationPreferences;
  referenceDate?: string;
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
  if (result.success) return sanitizeFeedbackComposition(result.data);
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

function modelEvidenceBundle(bundle: FeedbackEvidenceBundle, referenceDate?: string): FeedbackEvidenceBundle {
  if (!referenceDate) return bundle;
  const mapEvidence = (item: FeedbackEvidenceBundle["teachingEvidence"][number]) => ({
    ...item,
    content: replaceFeedbackDatesWithRelativeLabels(item.content, referenceDate),
    ...(item.occurredAt ? { occurredAt: relativeFeedbackDateLabel(referenceDate, item.occurredAt) } : {}),
  });
  const result: FeedbackEvidenceBundle = {
    ...bundle,
    teachingEvidence: bundle.teachingEvidence.map(mapEvidence),
    assessmentEvidence: bundle.assessmentEvidence.map(mapEvidence),
    communicationContext: bundle.communicationContext.map(mapEvidence),
    ...("teachingBackground" in bundle
      ? { teachingBackground: bundle.teachingBackground.map((value) => replaceFeedbackDatesWithRelativeLabels(value, referenceDate)) }
      : {}),
    ...("historySnapshot" in bundle
      ? {
          historySnapshot: bundle.historySnapshot
            ? {
                ...bundle.historySnapshot,
                current: bundle.historySnapshot.current ? { ...bundle.historySnapshot.current, date: relativeFeedbackDateLabel(referenceDate, bundle.historySnapshot.current.date) } : null,
                previous: bundle.historySnapshot.previous ? { ...bundle.historySnapshot.previous, date: relativeFeedbackDateLabel(referenceDate, bundle.historySnapshot.previous.date) } : null,
                recent: bundle.historySnapshot.recent.map((metric) => ({ ...metric, date: relativeFeedbackDateLabel(referenceDate, metric.date) })),
              }
            : null,
        }
      : {}),
  } as FeedbackEvidenceBundle;
  return result;
}

function normalizeCompositionDates(composition: FeedbackCompositionPlan, referenceDate?: string) {
  if (!referenceDate) return composition;
  const text = (value: string) => replaceFeedbackDatesWithRelativeLabels(value, referenceDate);
  return sanitizeFeedbackComposition({
    ...composition,
    parentAction: composition.parentAction ? {
      ...composition.parentAction,
      action: text(composition.parentAction.action),
      successCriteria: text(composition.parentAction.successCriteria),
      notNeeded: text(composition.parentAction.notNeeded),
    } : null,
    modules: composition.modules.map((module) => ({
      ...module,
      content: text(module.content),
      reason: text(module.reason),
    })),
    evidenceCoverage: composition.evidenceCoverage.map((coverage) => ({ ...coverage, statement: text(coverage.statement) })),
    draftFeedback: text(composition.draftFeedback),
  });
}

function parseModelComposition(value: string, stage: "draft" | "review" | "correction", referenceDate?: string) {
  return normalizeCompositionDates(normalizeCompositionDependencies(parseComposition(value, stage)), referenceDate);
}

function normalizedCoverageText(value: string) {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function retainCoveragePresentInFinalText(composition: FeedbackCompositionPlan) {
  const normalizedText = normalizedCoverageText(composition.draftFeedback);
  return {
    ...composition,
    evidenceCoverage: composition.evidenceCoverage.filter((coverage) => (
      normalizedText.includes(normalizedCoverageText(coverage.statement))
    )),
  };
}

/**
 * Three-layer feedback generation used by FeedbackPlan. The first layer is
 * supplied by the deterministic evidence service; this function only performs
 * the structured composition draft and constrained review/polish. The caller
 * must still run the deterministic audit before approval.
 */
export async function generateFeedbackPlanComposition(input: FeedbackPlanGenerationInput) {
  // Older persisted plans may still contain internal boundary metadata. Clean
  // it at the generation boundary without rewriting historical database rows.
  const evidence = sanitizeFeedbackEvidenceBundle(FeedbackEvidenceBundleSchema.parse(input.evidenceBundle));
  const modelEvidence = modelEvidenceBundle(evidence, input.referenceDate);
  const evidenceText = JSON.stringify(modelEvidence);
  const configuredModules = input.generationPreferences?.moduleKeys;
  const allowedModules = configuredModules?.length ? configuredModules : [...FEEDBACK_MODULES[input.planType]];
  const allowedClosures = input.generationPreferences
    ? [input.generationPreferences.closureType]
    : [...FEEDBACK_CLOSURES_BY_TYPE[input.planType]];
  const outputRequirement = sanitizeFeedbackPromptText(input.outputRequirement).trim();
  const evidenceIds = evidence.teachingEvidence.concat(evidence.assessmentEvidence, evidence.communicationContext)
    .filter((item) => item.confirmed && item.kind !== "model_candidate")
    .map((item) => item.id);
  const generationPreferenceBoundary = input.generationPreferences
    ? input.generationPreferences.moduleKeys.length
      ? `本计划在创建阶段已确定生成结构：只能使用结尾 ${input.generationPreferences.closureType}，只能在以下模块中选择：${input.generationPreferences.moduleKeys.join(", ")}。不得在本阶段改选其他结尾或模块。详略为 ${input.generationPreferences.length ?? "inherit"}，语气为 ${input.generationPreferences.tone ?? "inherit"}。`
      : `本计划在创建阶段没有预选模块；可以在当前反馈类型的完整模块目录中自然取舍，不要为了凑数量填充模块。结尾仍固定为 ${input.generationPreferences.closureType}。详略为 ${input.generationPreferences.length ?? "inherit"}，语气为 ${input.generationPreferences.tone ?? "inherit"}。`
    : "本计划没有保存生成结构偏好，按反馈类型的完整允许目录选择。";
  const baseProtocolBoundary = `当前类型允许的 module key 只有：${allowedModules.join(", ")}。
当前类型允许的 closureType 只有：${allowedClosures.join(", ")}。
evidenceRefs 只能逐字使用以下证据 ID：${evidenceIds.join(", ")}。

${generationPreferenceBoundary}

【时间语义协议】本次计划的目标课次作为“今天”的时间锚点。证据中的时间已经按实际发生时间分层为今天、昨天、前天或更早；不得把历史证据归入今天，不得在成稿中补写或重复精确日期。跨日沟通保留时间范围，不压成单日。

教师自然语言反馈要求与补充事实（最高优先级）：
${outputRequirement}

要求优先级：
1. 教师输入中的事实陈述视为教师已确认事实，可以补充或纠正证据包；与证据包冲突时，以教师本次输入为准；
2. 证据包中未被教师纠正的已确认事实继续作为内容底座；
3. 教师输入中的写作要求决定收件人、重点、语气、篇幅、表达顺序、取舍方式以及联想和分析尺度；
4. 内部结构化默认值只在教师自然语言没有说明时生效。
教师未指定收件人时，默认写给家长；教师明确指定其他收件人时按教师要求执行。
可以从教师输入与证据包共同形成的事实底座充分联想，形成原文没有直接写出的教学判断、可能原因和趋势解释；不要凭空编造两边都没有的具体事件、人物、分数或已经发生的动作。不要因为某句话属于分析、联想或推测就自动删除。`;
  const draftProtocolBoundary = `${baseProtocolBoundary}
已确认教学与测评证据应尽量自然地进入 draftFeedback；evidenceCoverage 用于帮助教师检查取舍，statement 应逐字出现在 draftFeedback 中。证据较多时可以合并判断、减少原始数据暴露，也可以把暂未写入正文的证据留给教师后续决定，不把覆盖检查当作阻断条件。`;
  const fullEvidenceStructuralCodes = new Set([
    "module_not_allowed",
    "evidence_ref_missing",
    "closure_not_allowed",
    "evidence_coverage_duplicate",
    "evidence_coverage_unknown",
  ]);
  const draftPrompt = `你是 Student Track 的反馈组装模型。请结合教师反馈要求、教师补充事实和证据包，为${input.studentName}生成结构化反馈组装方案。教师输入中的事实直接视为已确认事实；在这个事实底座上充分分析、联想、补充判断和自由表达。

反馈类型：${input.planType}
内部结构化默认值：表达风格 ${input.style}，篇幅 ${input.length}。仅在教师自然语言反馈要求未明确说明时采用。
确定性证据包：
${evidenceText}

结构协议（必须严格遵守）：
${draftProtocolBoundary}

规则：
1. modules 可以为空；如果纳入模块，只能从上面明确列出的 module key 中选择，不得自造、翻译或使用旧版模块名；若本计划已保存模块范围，只能从已选模块中选择。不要为了凑数量填充模块。内容来自证据包时填写对应 evidenceRefs；内容来自教师补充事实时 evidenceRefs 可以为空，不要伪造证据 ID。
2. teachingEvidence 与 assessmentEvidence 中的 confirmed=true 证据优先进入 included 模块和 draftFeedback；多条证据可以共同支撑同一个自然判断，不必逐项报数。evidenceCoverage 是教师复核辅助信息，能覆盖时填写，暂未覆盖不阻断草稿。
3. needParentAction 默认 false；教师要求需要家长配合时，再按自然表达填写 parentAction。
4. teacher_intervention、teacher_support、intervention_outcome 和 followup_observation 按内部结构字段正常输出；教师要求已经明确相关内容时，不要因为证据字段不完整而删掉正文。
5. closureType 只能从上面列出的当前类型选项中选择；若本计划已保存生成结构，必须使用已确定的结尾，不得因为示例中出现其他结尾就改选。
6. modules 和 evidenceCoverage 是审计元数据，不是正文模板。draftFeedback 应以教师判断为主体：从题目和课堂表现判断哪些内容已经能够使用、哪里还没有真正消化，以及问题更接近知识理解、条件识别、步骤习惯还是迁移能力。
7. 数据只用作家长能理解的判断锚点。优先保留总正确率和有解释价值的变化；题号、分项分数和重复数字尽量转化为知识点、方法或能力判断。
8. 主动分析教师输入和证据材料放在一起可能说明什么、当前更值得关注什么、哪些积极或风险信号正在出现。可以充分提出原文没有直接写出的解释、趋势和教学判断；不要凭空补出教师输入与证据包都没有的具体事件、人物、分数和已经发生的动作。
9. 这是供后续审核和老师删改的充分初稿，不使用最终长度要求。优先多保留有价值的判断、证据联系和表达角度；从最自然的地方起笔，不套固定顺序，证据较多时分句表达，并保留完整主语、连接词、适度重复和自然停顿。不要写标题或项目符号。

只返回 JSON：{
  "version":1,
  "closureType":"informational|positive_recognition|teacher_resolved|home_cooperation|continued_observation",
  "needParentAction":false,
  "parentAction":null,
  "modules":[{"key":"...","content":"...","evidenceRefs":[],"status":"included|omitted|blocked","reason":"..."}],
  "evidenceCoverage":[{"evidenceId":"...","statement":"draftFeedback 中逐字存在的对应事实短句"}],
  "draftFeedback":"..."
}`;
  const draftRaw = await generateDraft(input.draftClient, input.draftModel, draftPrompt, input.signal, input.profileId, "json");
  let draftComposition;
  try {
    draftComposition = parseModelComposition(draftRaw, "draft", input.referenceDate);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "llm_schema_invalid") throw error;
    const repairPrompt = `你是 Student Track 的结构修复模型。下面的反馈组装输出不是合法结构，请只做 JSON 结构修复，完整保留教师要求授权的内容与表达力度。

反馈类型：${input.planType}
${draftProtocolBoundary}

无效输出：
${draftRaw.slice(0, 12000)}

请返回完整 JSON，必须包含 version=1、closureType、needParentAction、parentAction、modules、evidenceCoverage、draftFeedback。parentAction 不需要时必须为 null；每个 module 必须包含 key、content、evidenceRefs、status、reason；evidenceCoverage 只保留能够在 draftFeedback 中逐字找到的条目。`;
    const repairClient = input.generationMode === "fast" ? input.draftClient : input.reviewClient;
    const repairModel = input.generationMode === "fast" ? input.draftModel : input.reviewModel;
    const repairedResponse = await createReviewCompletion(repairClient, repairModel, repairPrompt, input.signal, { disableReasoning: true, profileId: input.profileId });
    const repairedContent = repairedResponse.choices[0]?.message?.content?.trim();
    if (!repairedContent) throw error;
    draftComposition = parseModelComposition(repairedContent, "draft", input.referenceDate);
  }
  let draftAudit = createAuditSnapshot(
    draftComposition,
    evidence,
    input.existingTaskIds,
    undefined,
    { enforceParentAudience: false, generationPreferences: input.generationPreferences },
  );
  if (input.generationMode === "fast") {
    const composition = retainCoveragePresentInFinalText(draftComposition);
    return {
      draftComposition,
      composition,
      audit: createAuditSnapshot(
        composition,
        evidence,
        input.existingTaskIds,
        undefined,
        { enforceParentAudience: false, generationPreferences: input.generationPreferences },
      ),
      reviewRaw: null,
    };
  }
  const draftCoverageIssues = () => draftAudit.items.filter((issue) => fullEvidenceStructuralCodes.has(issue.code));
  if (draftCoverageIssues().length > 0) {
    const coverageRepairPrompt = `你是 Student Track 的结构修复模型。上一版初稿存在 JSON 结构或证据引用元数据问题，请只修复这些结构字段，并完整保留教师要求所授权的分析、联想和自由表达。证据覆盖不完整本身只是教师可调整的软提醒，不要为了补齐覆盖而堆叠原始数据。

反馈类型：${input.planType}
${draftProtocolBoundary}

确定性证据包：
${evidenceText}

上一版初稿：
${JSON.stringify(draftComposition)}

必须修正的问题：
${draftCoverageIssues().map((issue) => `- ${issue.message}`).join("\n")}

只返回完整 JSON，字段为 version、closureType、needParentAction、parentAction、modules、evidenceCoverage、draftFeedback。不要为了覆盖检查改写或扩充无关内容。`;
    const correctedDraftResponse = await createReviewCompletion(input.reviewClient, input.reviewModel, coverageRepairPrompt, input.signal, { profileId: input.profileId });
    const correctedDraftContent = correctedDraftResponse.choices[0]?.message?.content?.trim();
    if (correctedDraftContent) {
      try {
        draftComposition = parseModelComposition(correctedDraftContent, "correction", input.referenceDate);
        draftAudit = createAuditSnapshot(
          draftComposition,
          evidence,
          input.existingTaskIds,
          undefined,
          { enforceParentAudience: false, generationPreferences: input.generationPreferences },
        );
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "llm_schema_invalid") throw error;
      }
    }
  }
  const unresolvedDraftIssues = draftCoverageIssues();
  const reviewPrompt = `你是 Student Track 的反馈审核与润色模型。请按照教师自然语言反馈要求和补充事实审核并润色组装方案。教师输入中的事实视为已确认事实，并优先于证据包中的旧信息。核对姓名、事件、分数和动作是否与这份合并后的事实底座冲突；在事实正确的前提下，不要把审核做成删减器，应保留并改善充分的分析、联想、推测、建议和自由表达。

确定性证据包：
${evidenceText}

组装方案：
${JSON.stringify(draftComposition)}

结构协议（优先级高于原组装方案）：
${baseProtocolBoundary}

初稿覆盖检查：
${unresolvedDraftIssues.length
    ? unresolvedDraftIssues.map((issue) => `- ${issue.message}`).join("\n")
    : "已覆盖全部确认的教学与测评证据。"}

审核规则：
1. 所有 included 模块必须使用当前类型允许的精确 key。来自证据包的内容使用有效 evidenceRefs；来自教师补充事实的内容允许 evidenceRefs=[]，不要为了满足结构而伪造引用。原方案中的旧版或自造 key 必须改成当前目录中的合适 key。
2. 审核时优先把覆盖检查中仍缺失的证据自然补入教师判断，并保留已经有依据的判断；但未覆盖本身只是软提醒，不得因此阻断、反复纠错或为了篇幅堆叠原始数据。可以减少分项分数、题号和重复数字，只留下总正确率或有解释价值的变化等标志性数据。只有正文确实删除证据含义时，才同步删除对应 evidenceCoverage。
3. 让教师判断比数据更突出。说明哪里学得还可以、哪里没有真正消化，以及材料共同指向的知识、方法或能力问题；如果教师要求允许，可以进一步提出趋势和原因判断。
4. 不要因为存在联想、推测或教学判断就自动删除。联想与教师输入及未被纠正的证据事实不冲突时，保留其表达力度；只有编出了两类输入都没有的具体事实，或与教师输入明确冲突时才修正。润色时从最自然的地方展开，不套固定顺序；可以拆开高密度长句、补回自然主语和过渡，并保留适度冗余与变化的语序。长度偏好 ${input.length} 与表达风格 ${input.style} 只是教师要求没有说明时的内部默认值。
5. 家长动作开关、教师处理、处理结果和后续观察遵守字段依赖。
6. 审核处理姓名串用、空正文、JSON 结构错误以及与合并事实底座的明确冲突；合理联想、教学判断和建议不因缺少原文逐字对应而自动删减。
7. closureType 必须属于当前类型允许列表；原方案越界时必须纠正。
8. 只返回完整结构化 JSON，draftFeedback 是供老师继续删改的家长文本草稿。

返回字段必须包含 version、closureType、needParentAction、parentAction、modules、evidenceCoverage 和 draftFeedback；modules 使用 key、content、evidenceRefs、status、reason；evidenceCoverage 使用 evidenceId、statement。`;
  const reviewedResponse = await createReviewCompletion(input.reviewClient, input.reviewModel, reviewPrompt, input.signal, { profileId: input.profileId });
  let reviewedContent = reviewedResponse.choices[0]?.message?.content?.trim();
  if (!reviewedContent) throw new Error("反馈审核模型返回空结果");
  let reviewedComposition;
  try {
    reviewedComposition = parseModelComposition(reviewedContent, "review", input.referenceDate);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "llm_schema_invalid") throw error;
    const repairReviewPrompt = `你是 Student Track 的审核结果结构修复模型。上一份审核输出不是合法 JSON。请只修复 JSON 结构，完整保留教师反馈要求授权的内容，不要借结构修复删减分析、联想、建议或承诺。

反馈类型：${input.planType}
${baseProtocolBoundary}

确定性证据包：
${evidenceText}

无效审核输出：
${reviewedContent.slice(0, 12000)}

只返回完整 JSON，字段必须包含 version=1、closureType、needParentAction、parentAction、modules、evidenceCoverage、draftFeedback。无需家长动作时 needParentAction=false 且 parentAction=null；evidenceCoverage 的 statement 必须逐字出现在 draftFeedback 中。`;
    const repairedReview = await createReviewCompletion(input.reviewClient, input.reviewModel, repairReviewPrompt, input.signal, { disableReasoning: true, profileId: input.profileId });
    const repairedContent = repairedReview.choices[0]?.message?.content?.trim();
    if (!repairedContent) throw error;
    try {
      reviewedContent = repairedContent;
      reviewedComposition = parseModelComposition(repairedContent, "review", input.referenceDate);
    } catch (repairError) {
      if (!(repairError instanceof ApiError) || repairError.code !== "llm_schema_invalid") throw repairError;
      reviewedComposition = draftComposition;
      reviewedContent = JSON.stringify(draftComposition);
    }
  }
  reviewedComposition = retainCoveragePresentInFinalText(reviewedComposition);
  let audit = createAuditSnapshot(
    reviewedComposition,
    evidence,
    input.existingTaskIds,
    undefined,
    { enforceParentAudience: false, generationPreferences: input.generationPreferences },
  );
  const blocked = audit.items.filter((issue) => issue.severity === "blocked");
  if (blocked.length) {
    const correctionPrompt = `你是 Student Track 的结构纠错模型。上一版反馈未通过程序门禁，请只修正 JSON 结构、空正文或姓名串用等明确技术问题。完整保留教师反馈要求授权的分析、联想、建议和自由表达，不要为了补结构退回逐项报数。

反馈类型：${input.planType}
${baseProtocolBoundary}

确定性证据包：
${evidenceText}

上一版结果：
${JSON.stringify(reviewedComposition)}

必须修正的问题：
${blocked.map((issue) => `- ${issue.message}`).join("\n")}

只返回完整 JSON，字段为 version、closureType、needParentAction、parentAction、modules、evidenceCoverage、draftFeedback。modules 可以为空；如果存在 included 模块，key 和 evidenceRefs 只能取上面允许的精确值；evidenceCoverage 只能保留 statement 仍逐字存在于 draftFeedback 的条目。`;
    try {
      const correctedResponse = await createReviewCompletion(input.reviewClient, input.reviewModel, correctionPrompt, input.signal, { profileId: input.profileId });
      const correctedContent = correctedResponse.choices[0]?.message?.content?.trim();
      if (correctedContent) {
        reviewedComposition = parseModelComposition(correctedContent, "correction", input.referenceDate);
        reviewedComposition = retainCoveragePresentInFinalText(reviewedComposition);
        audit = createAuditSnapshot(
          reviewedComposition,
          evidence,
          input.existingTaskIds,
          undefined,
          { enforceParentAudience: false, generationPreferences: input.generationPreferences },
        );
      }
    } catch {
      throwIfAborted(input.signal);
      // 结构纠错是可选增强。已有可读草稿时，超时或协议错误只保留在
      // audit 中交给教师处理，不能把整条反馈丢弃。
    }
  }
  return {
    draftComposition,
    composition: reviewedComposition,
    audit,
    reviewRaw: reviewedContent,
  };
}
