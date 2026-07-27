export const FEEDBACK_OUTPUT_SECTION_KEYS = [
  "flaggedIssue",
  "trendChange",
  "backgroundBaseline",
  "strategySuggestion",
  "suggestedFeedback",
] as const;

export type FeedbackOutputSectionKey = typeof FEEDBACK_OUTPUT_SECTION_KEYS[number];

export interface FeedbackOutputStrategy {
  flaggedIssue: boolean;
  trendChange: boolean;
  backgroundBaseline: boolean;
  strategySuggestion: boolean;
  suggestedFeedback: boolean;
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
    strategy: { flaggedIssue: true, trendChange: false, backgroundBaseline: false, strategySuggestion: false, suggestedFeedback: true },
  },
  attention: {
    label: "关注学生优先",
    description: "补充趋势、基线与教师下一步，再生成家长文本。",
    strategy: { flaggedIssue: true, trendChange: true, backgroundBaseline: true, strategySuggestion: true, suggestedFeedback: true },
  },
  teacher: {
    label: "教师研判",
    description: "只生成内部结构化研判，不调用模型成文。",
    strategy: { flaggedIssue: true, trendChange: true, backgroundBaseline: true, strategySuggestion: true, suggestedFeedback: false },
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
  };
}

export function feedbackOutputPresetFor(strategy: FeedbackOutputStrategy): FeedbackOutputPreset | null {
  return (Object.keys(FEEDBACK_OUTPUT_PRESETS) as FeedbackOutputPreset[]).find((key) => {
    const candidate = FEEDBACK_OUTPUT_PRESETS[key].strategy;
    return (Object.keys(candidate) as FeedbackOutputSectionKey[]).every((section) => candidate[section] === strategy[section]);
  }) ?? null;
}
