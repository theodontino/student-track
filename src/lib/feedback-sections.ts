export const FEEDBACK_OUTPUT_SECTION_KEYS = [
  "flaggedIssue",
  "trendChange",
  "backgroundBaseline",
  "strategySuggestion",
  "suggestedFeedback",
] as const;

export type FeedbackOutputSectionKey = typeof FEEDBACK_OUTPUT_SECTION_KEYS[number];

export const FEEDBACK_STYLES = [
  "gentle",
  "professional",
  // Legacy values remain readable so 1.1.0-beta.1 WorkHistory and replay
  // snapshots do not become invalid after the expression controls change.
  "concise_objective",
  "balanced",
  "encouraging",
] as const;
export type FeedbackStyle = typeof FEEDBACK_STYLES[number];
export const FEEDBACK_STYLE_CHOICES = ["gentle", "professional"] as const;
export type FeedbackStyleChoice = typeof FEEDBACK_STYLE_CHOICES[number];

export const FEEDBACK_LENGTHS = ["short", "standard"] as const;
export type FeedbackLength = typeof FEEDBACK_LENGTHS[number];

export const FEEDBACK_STYLE_OPTIONS: Record<FeedbackStyle, {
  label: string;
  instruction: string;
}> = {
  gentle: {
    label: "温和",
    instruction: "语气自然、有耐心，让家长看清孩子被观察到的具体表现和需要说明的问题；不得虚构表扬或淡化事实。",
  },
  professional: {
    label: "专业",
    instruction: "表达清楚、克制，以事实、依据和明确判断为主，避免情绪化修饰和空泛鼓励。",
  },
  concise_objective: {
    label: "简洁客观",
    instruction: "表达直接、克制、以事实和具体依据为主，不增加情绪性修饰。",
  },
  balanced: {
    label: "均衡",
    instruction: "在事实准确的前提下兼顾解释与关照，语气自然、温和但不夸张。",
  },
  encouraging: {
    label: "鼓励型",
    instruction: "优先呈现证据支持的努力、方法或进步信号，并给出有边界的鼓励；不得虚构表扬或淡化问题。",
  },
};

export const FEEDBACK_LENGTH_OPTIONS: Record<FeedbackLength, {
  label: string;
  instruction: string;
}> = {
  short: {
    label: "简洁",
    instruction: "用较少句子直接说明一个最重要的事实或问题，不追求固定字符数。",
  },
  standard: {
    label: "详细",
    instruction: "在核心事实之外补充必要依据和有边界的解释，但不堆砌材料，不追求固定字符数。",
  },
};

export interface FeedbackOutputStrategy {
  flaggedIssue: boolean;
  trendChange: boolean;
  backgroundBaseline: boolean;
  strategySuggestion: boolean;
  suggestedFeedback: boolean;
  style: FeedbackStyle;
  length: FeedbackLength;
}

export type FeedbackOutputPreset = "light" | "attention" | "teacher";

export const FEEDBACK_OUTPUT_PRESETS: Record<FeedbackOutputPreset, {
  label: string;
  description: string;
  strategy: FeedbackOutputStrategy;
}> = {
  light: {
    label: "轻量反馈",
    description: "只突出本次需要说明的问题，并生成简短家长文本。",
    strategy: { flaggedIssue: true, trendChange: false, backgroundBaseline: false, strategySuggestion: false, suggestedFeedback: true, style: "gentle", length: "standard" },
  },
  attention: {
    label: "关注学生优先",
    description: "补充趋势、基线与教师下一步，再生成家长文本。",
    strategy: { flaggedIssue: true, trendChange: true, backgroundBaseline: true, strategySuggestion: true, suggestedFeedback: true, style: "gentle", length: "standard" },
  },
  teacher: {
    label: "教师研判",
    description: "只生成内部结构化研判，不调用模型成文。",
    strategy: { flaggedIssue: true, trendChange: true, backgroundBaseline: true, strategySuggestion: true, suggestedFeedback: false, style: "gentle", length: "standard" },
  },
};

export const DEFAULT_FEEDBACK_OUTPUT_STRATEGY = FEEDBACK_OUTPUT_PRESETS.light.strategy;

export type FeedbackSectionSource = "current-session" | "history" | "assessment" | "teaching-summary";

export interface FeedbackSectionEvidence {
  source: FeedbackSectionSource;
  label: string;
}

export interface FeedbackSection {
  content: string;
  evidence: FeedbackSectionEvidence[];
}

/** Structured facts are stored with the batch and remain teacher-facing by default. */
export interface FeedbackSections {
  currentFact: FeedbackSection;
  flaggedIssue?: FeedbackSection;
  trendChange?: FeedbackSection;
  backgroundBaseline?: FeedbackSection;
  renewalAlert?: FeedbackSection;
  strategySuggestion?: FeedbackSection;
}

export function normalizeFeedbackOutputStrategy(
  value: Partial<FeedbackOutputStrategy> | undefined,
): FeedbackOutputStrategy {
  return {
    flaggedIssue: typeof value?.flaggedIssue === "boolean" ? value.flaggedIssue : DEFAULT_FEEDBACK_OUTPUT_STRATEGY.flaggedIssue,
    trendChange: typeof value?.trendChange === "boolean" ? value.trendChange : DEFAULT_FEEDBACK_OUTPUT_STRATEGY.trendChange,
    backgroundBaseline: typeof value?.backgroundBaseline === "boolean" ? value.backgroundBaseline : DEFAULT_FEEDBACK_OUTPUT_STRATEGY.backgroundBaseline,
    strategySuggestion: typeof value?.strategySuggestion === "boolean" ? value.strategySuggestion : DEFAULT_FEEDBACK_OUTPUT_STRATEGY.strategySuggestion,
    suggestedFeedback: typeof value?.suggestedFeedback === "boolean" ? value.suggestedFeedback : DEFAULT_FEEDBACK_OUTPUT_STRATEGY.suggestedFeedback,
    style: value?.style === "professional" || value?.style === "concise_objective"
      ? "professional"
      : "gentle",
    length: value?.length && FEEDBACK_LENGTHS.includes(value.length) ? value.length : "standard",
  };
}

export function feedbackOutputPresetFor(strategy: FeedbackOutputStrategy): FeedbackOutputPreset | null {
  return (Object.keys(FEEDBACK_OUTPUT_PRESETS) as FeedbackOutputPreset[]).find((key) => {
    const candidate = FEEDBACK_OUTPUT_PRESETS[key].strategy;
    return FEEDBACK_OUTPUT_SECTION_KEYS.every((section) => candidate[section] === strategy[section]);
  }) ?? null;
}

export function feedbackStyleInstruction(style: FeedbackStyle) {
  return FEEDBACK_STYLE_OPTIONS[style].instruction;
}

export function feedbackLengthRequirement(length: FeedbackLength) {
  return FEEDBACK_LENGTH_OPTIONS[length].instruction;
}

export function visibleFeedbackLength(value: string) {
  return Array.from(value.replace(/\s/gu, "")).length;
}

export function feedbackLengthIssue(value: string, length: FeedbackLength) {
  void value;
  void length;
  return null;
}

export function isLegacyLengthOnlyReview(issues: string[] | undefined) {
  return Boolean(issues?.length) && issues!.every((issue) => (
    /反馈长度为\s*\d+\s*个可见字符，应为/.test(issue)
    || issue.includes("达到所选长度后即可解除导出限制")
  ));
}
