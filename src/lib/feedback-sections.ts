export const FEEDBACK_OUTPUT_SECTION_KEYS = [
  "flaggedIssue",
  "trendChange",
  "backgroundBaseline",
  "strategySuggestion",
  "suggestedFeedback",
] as const;

export type FeedbackOutputSectionKey = typeof FEEDBACK_OUTPUT_SECTION_KEYS[number];

export const FEEDBACK_STYLES = [
  "concise_objective",
  "balanced",
  "encouraging",
] as const;
export type FeedbackStyle = typeof FEEDBACK_STYLES[number];

export const FEEDBACK_LENGTHS = ["short", "standard"] as const;
export type FeedbackLength = typeof FEEDBACK_LENGTHS[number];

export const FEEDBACK_STYLE_OPTIONS: Record<FeedbackStyle, {
  label: string;
  instruction: string;
}> = {
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
  min: number;
  max: number;
}> = {
  short: { label: "短（60–89 字符）", min: 60, max: 89 },
  standard: { label: "标准（90–140 字符）", min: 90, max: 140 },
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
    strategy: { flaggedIssue: true, trendChange: false, backgroundBaseline: false, strategySuggestion: false, suggestedFeedback: true, style: "balanced", length: "standard" },
  },
  attention: {
    label: "关注学生优先",
    description: "补充趋势、基线与教师下一步，再生成家长文本。",
    strategy: { flaggedIssue: true, trendChange: true, backgroundBaseline: true, strategySuggestion: true, suggestedFeedback: true, style: "balanced", length: "standard" },
  },
  teacher: {
    label: "教师研判",
    description: "只生成内部结构化研判，不调用模型成文。",
    strategy: { flaggedIssue: true, trendChange: true, backgroundBaseline: true, strategySuggestion: true, suggestedFeedback: false, style: "balanced", length: "standard" },
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
    style: value?.style && FEEDBACK_STYLES.includes(value.style) ? value.style : "balanced",
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
  const option = FEEDBACK_LENGTH_OPTIONS[length];
  return `${option.min}–${option.max} 个可见字符（空白不计，标点计入）`;
}

export function visibleFeedbackLength(value: string) {
  return Array.from(value.replace(/\s/gu, "")).length;
}

export function feedbackLengthIssue(value: string, length: FeedbackLength) {
  const actual = visibleFeedbackLength(value);
  const option = FEEDBACK_LENGTH_OPTIONS[length];
  if (actual >= option.min && actual <= option.max) return null;
  return `反馈长度为 ${actual} 个可见字符，应为 ${option.min}–${option.max} 个`;
}
