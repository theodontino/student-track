const RECIPIENT_PLACEHOLDER_PATTERN =
  /(?:[xｘＸ×＊*]{2,}|某某|学生姓名|孩子姓名|姓名占位)\s*(?:同学)?\s*(?:妈妈|爸爸|家长)/iu;

const STUDENT_DIRECTED_ADDRESS_PATTERN =
  /(?:你们?|(?:同学|孩子)\s*[，,：:]?\s*(?:你好|您好))/iu;

const INTERNAL_FEEDBACK_BOUNDARY_PATTERNS = [
  /证据边界[：:]\s*只能解释本次结果，不据此推断长期能力或人格特征[。！？!?；;]?/gu,
  /内部推断边界（不要写入家长反馈）[：:]\s*只将本报告视为本次答题证据，不据此推断长期能力或人格特征，也不要添加固定免责声明[。！？!?；;]?/gu,
];

/** Detects template recipient tokens that must never enter parent-facing text. */
export function containsRecipientPlaceholder(value: string) {
  return RECIPIENT_PLACEHOLDER_PATTERN.test(value.normalize("NFKC"));
}

/** Detects model output that switches a parent-facing message into direct student address. */
export function containsStudentDirectedAddress(value: string) {
  return STUDENT_DIRECTED_ADDRESS_PATTERN.test(value.normalize("NFKC"));
}

/** Replaces template recipient tokens in model input without mutating the persisted source. */
export function sanitizeFeedbackPromptText(value: string) {
  return value.normalize("NFKC").replace(
    /(?:[xｘＸ×＊*]{2,}|某某|学生姓名|孩子姓名|姓名占位)\s*(?:同学)?\s*(?:妈妈|爸爸|家长)/giu,
    "家长",
  );
}

/** Keeps stored communication content intact while preventing its placeholder target from entering prompts. */
export function safeFeedbackCommunicationTarget(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return !normalized || containsRecipientPlaceholder(normalized) ? "家长" : normalized;
}

/** Removes internal evidence-boundary metadata from any parent-facing text. */
export function stripFeedbackInternalBoundary(value: string) {
  return INTERNAL_FEEDBACK_BOUNDARY_PATTERNS.reduce((text, pattern) => text.replace(pattern, ""), value)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/。{2,}/g, "。")
    .trim();
}
