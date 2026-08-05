const RECIPIENT_PLACEHOLDER_PATTERN =
  /(?:[xｘＸ×＊*]{2,}|某某|学生姓名|孩子姓名|姓名占位)\s*(?:同学)?\s*(?:妈妈|爸爸|家长)/iu;

const STUDENT_DIRECTED_ADDRESS_PATTERN =
  /(?:你们?|(?:同学|孩子)\s*[，,：:]?\s*(?:你好|您好))/iu;

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
