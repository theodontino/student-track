import { CommunicationPreferenceSchema, type CommunicationPreference } from "@/lib/feedback-plan";

export const COMMUNICATION_PREFERENCE_SIGNAL_VALUES = {
  length: ["short", "standard", "detailed"],
  deliveryChannel: ["text", "voice", "either"],
  phoneContact: ["accepted", "not_accepted"],
  evidence: ["teacher_conclusion", "classroom_example", "data_trend"],
  terminology: ["plain", "basic", "professional"],
  familyParticipation: ["inform_only", "remind_confirm", "observe_report", "simple_check"],
  frequency: ["every_session", "stage_only", "exception_only"],
} as const;

export type CommunicationPreferenceSignalField = keyof typeof COMMUNICATION_PREFERENCE_SIGNAL_VALUES;
export type CommunicationPreferenceSignal = {
  field: CommunicationPreferenceSignalField;
  value: string;
  messageId: string;
  quote: string;
};

export function communicationPreferenceFromSignals(value: unknown): {
  preference: CommunicationPreference;
  signals: string[];
  messageIds: string[];
} | null {
  if (!Array.isArray(value)) return null;
  const controlled = new Map<CommunicationPreferenceSignalField, string>();
  const messageIds = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    const field = candidate.field as CommunicationPreferenceSignalField;
    const allowed = COMMUNICATION_PREFERENCE_SIGNAL_VALUES[field] as readonly string[] | undefined;
    const signalValue = typeof candidate.value === "string" ? candidate.value : "";
    const messageId = typeof candidate.messageId === "string" ? candidate.messageId.trim() : "";
    const quote = typeof candidate.quote === "string" ? candidate.quote.trim() : "";
    if (!allowed?.includes(signalValue) || !messageId || !quote || controlled.has(field)) return null;
    controlled.set(field, signalValue);
    messageIds.add(messageId);
  }
  if (controlled.size === 0) return null;
  const preference = CommunicationPreferenceSchema.parse({
    version: 1,
    length: controlled.get("length") ?? "unknown",
    deliveryChannel: controlled.get("deliveryChannel") ?? "unknown",
    phoneContact: controlled.get("phoneContact") ?? "unknown",
    evidence: controlled.get("evidence") ?? "unknown",
    terminology: controlled.get("terminology") ?? "unknown",
    familyParticipation: controlled.get("familyParticipation") ?? "unknown",
    frequency: controlled.get("frequency") ?? "unknown",
  });
  return {
    preference,
    signals: [...controlled].map(([field, signalValue]) => `${field}:${signalValue}`),
    messageIds: [...messageIds],
  };
}

/**
 * Extracts only explicit communication signals from an already confirmed
 * summary. This is deliberately conservative: it creates a pending candidate
 * and never changes the active family preference automatically.
 */
export function inferCommunicationPreferenceCandidate(summary: string): {
  preference: CommunicationPreference;
  signals: string[];
} | null {
  const text = summary.trim();
  if (!text) return null;
  const preference = {
    version: 1 as const,
    length: /简短|短一些|不要太长|一句话/u.test(text) ? "short" : /详细|具体说明|展开讲|多说一些/u.test(text) ? "detailed" : "unknown",
    deliveryChannel: /文字(?:反馈)?(?:更方便|为主|优先)|倾向.{0,4}文字/u.test(text) ? "text" : /语音(?:反馈)?(?:更方便|为主|优先)|倾向.{0,4}语音/u.test(text) ? "voice" : /语音.{0,8}文字.{0,8}(?:都|均)(?:可|可以|接受)|(?:都|均)(?:可|可以|接受).{0,8}语音.{0,8}文字/u.test(text) ? "either" : "unknown",
    phoneContact: /(?:不接受|不要|不方便).{0,6}(?:微信)?电话/u.test(text) ? "not_accepted" : /(?:接受|可以|可).{0,6}(?:微信)?电话/u.test(text) ? "accepted" : "unknown",
    evidence: /分数|数据|趋势/u.test(text) ? "data_trend" : /例子|课堂片段|具体表现/u.test(text) ? "classroom_example" : /结论|结果/u.test(text) ? "teacher_conclusion" : "unknown",
    terminology: /术语|专业|知识点细节|方法步骤/u.test(text) ? "professional" : /简单说|通俗|不懂化学|听不懂术语/u.test(text) ? "plain" : "unknown",
    familyParticipation: /老师您处理|家长不用|不需要家长|只需要告知|了解情况即可/u.test(text) ? "inform_only" : /提醒|确认是否完成|拍照|检查一下/u.test(text) ? "remind_confirm" : /请家长观察|家长观察后反馈|在家做题后反馈|反馈异常|反馈完成情况/u.test(text) ? "observe_report" : "unknown",
    frequency: /每次课|每节课|每次都/u.test(text) ? "every_session" : /阶段性|阶段总结|一段时间后/u.test(text) ? "stage_only" : /有问题时|异常时|需要时/u.test(text) ? "exception_only" : "unknown",
  } satisfies CommunicationPreference;
  const signals = Object.entries(preference)
    .filter(([key, value]) => key !== "version" && value !== "unknown")
    .map(([key, value]) => `${key}:${value}`);
  if (signals.length === 0) return null;
  return { preference: CommunicationPreferenceSchema.parse(preference), signals };
}
