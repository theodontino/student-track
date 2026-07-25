export const FEEDBACK_COMMUNICATION_CATEGORIES = [
  "learning-progress",
  "learning-difficulty",
  "learning-habit",
  "learning-method",
  "learning-confidence",
  "parent-concern",
  "feedback-preference",
  "teacher-commitment",
  "temporary-learning-context",
] as const;

export type FeedbackCommunicationCategory = typeof FEEDBACK_COMMUNICATION_CATEGORIES[number];
export type FeedbackCommunicationPriority = "high" | "medium" | "low";

export const FEEDBACK_COMMUNICATION_CATEGORY_LABELS: Record<FeedbackCommunicationCategory, string> = {
  "learning-progress": "学习进步",
  "learning-difficulty": "具体困难",
  "learning-habit": "学习习惯",
  "learning-method": "学习方法",
  "learning-confidence": "学习信心",
  "parent-concern": "家长关切",
  "feedback-preference": "反馈偏好",
  "teacher-commitment": "教师承诺",
  "temporary-learning-context": "临时学习背景",
};

export interface FeedbackUseDecision {
  relevant: boolean;
  category: FeedbackCommunicationCategory;
  priority: FeedbackCommunicationPriority;
}

const STORED_PREFIX = /^\[ST反馈上下文｜实际沟通:\s*([^｜\]]+)｜类别:\s*([^｜\]]+)｜优先级:\s*([^｜\]]+)\]\s*/;
const LEGACY_FEEDBACK_RELEVANCE = /学习|课堂|听课|成绩|分数|作业|复习|预习|笔记|测验|考试|错题|正确率|知识|方法|理解|掌握|不会|跟不上|难度|觉得难|信心|担心|焦虑|粗心|认真|专注|注意力|犯困|退班|续班|反馈|进步|提高|复盘|弱项|死记硬背|逻辑|身体不适|睡眠|作息|疲惫|头疼|生病/;

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeFeedbackUseDecision(value: unknown): FeedbackUseDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const category = clean(candidate.category);
  const priority = clean(candidate.priority);
  if (
    typeof candidate.relevant !== "boolean"
    || !FEEDBACK_COMMUNICATION_CATEGORIES.includes(category as FeedbackCommunicationCategory)
    || !["high", "medium", "low"].includes(priority)
  ) return null;
  return {
    relevant: candidate.relevant,
    category: category as FeedbackCommunicationCategory,
    priority: priority as FeedbackCommunicationPriority,
  };
}

export function shouldPersistFeedbackCommunication(value: unknown) {
  const decision = normalizeFeedbackUseDecision(value);
  return Boolean(decision?.relevant && decision.priority !== "low");
}

export function formatFeedbackCommunicationSummary(
  summary: string,
  occurredAt: string,
  decision: FeedbackUseDecision,
) {
  const body = summary.trim();
  if (!body || STORED_PREFIX.test(body)) return body;
  return `[ST反馈上下文｜实际沟通: ${occurredAt || "未知"}｜类别: ${decision.category}｜优先级: ${decision.priority}] ${body}`;
}

export function parseFeedbackCommunicationSummary(summary: string) {
  const normalized = summary.trim();
  const match = normalized.match(STORED_PREFIX);
  if (!match) {
    return {
      summary: normalized,
      occurredAt: "",
      decision: null as FeedbackUseDecision | null,
    };
  }
  return {
    summary: normalized.slice(match[0].length).trim(),
    occurredAt: match[1].trim(),
    decision: normalizeFeedbackUseDecision({
      relevant: true,
      category: match[2].trim(),
      priority: match[3].trim(),
    }),
  };
}

export function isUsefulLegacyFeedbackCommunication(summary: string) {
  const parsed = parseFeedbackCommunicationSummary(summary);
  if (parsed.decision) return shouldPersistFeedbackCommunication(parsed.decision);
  return LEGACY_FEEDBACK_RELEVANCE.test(parsed.summary);
}
