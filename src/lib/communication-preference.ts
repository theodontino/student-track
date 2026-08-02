import { CommunicationPreferenceSchema, type CommunicationPreference } from "@/lib/feedback-plan";

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
    evidence: /分数|数据|趋势/u.test(text) ? "data_trend" : /例子|课堂片段|具体表现/u.test(text) ? "classroom_example" : /结论|结果/u.test(text) ? "teacher_conclusion" : "unknown",
    terminology: /术语|专业|知识点细节|方法步骤/u.test(text) ? "professional" : /简单说|通俗|不懂化学|听不懂术语/u.test(text) ? "plain" : "unknown",
    familyParticipation: /老师您处理|家长不用|不需要家长|只需要告知|了解情况即可/u.test(text) ? "inform_only" : /提醒|确认是否完成|拍照|检查一下/u.test(text) ? "remind_confirm" : /观察|反馈异常|在家做题|完成情况/u.test(text) ? "observe_report" : "unknown",
    frequency: /每次课|每节课|每次都/u.test(text) ? "every_session" : /阶段性|阶段总结|一段时间后/u.test(text) ? "stage_only" : /有问题时|异常时|需要时/u.test(text) ? "exception_only" : "unknown",
  } satisfies CommunicationPreference;
  const signals = Object.entries(preference)
    .filter(([key, value]) => key !== "version" && value !== "unknown")
    .map(([key, value]) => `${key}:${value}`);
  if (signals.length === 0) return null;
  return { preference: CommunicationPreferenceSchema.parse(preference), signals };
}
