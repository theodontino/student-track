import { createHash } from "node:crypto";
import { z } from "zod";

const safeIdentifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sha256Fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestamp = z.string().refine((value) => (
  value.length <= 40
  && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && !Number.isNaN(Date.parse(value))
), "必须是带时区的 ISO 8601 时间");

const WccMessageSchema = z.object({
  id: safeIdentifier,
  sender: z.string().max(200).nullable().optional(),
  direction: z.string().max(40).nullable().optional(),
  sentAt: timestamp.nullable().optional(),
  timeContext: z.string().max(120).nullable().optional(),
  type: z.string().max(80).nullable().optional(),
  content: z.string().min(1).max(20_000),
  confidence: z.number().min(0).max(1).nullable().optional(),
}).strict();

export const WccStudentTrackFileV1Schema = z.object({
  contractVersion: z.literal("wcc.student-track-file.v1"),
  packageId: safeIdentifier,
  producedAt: timestamp,
  producer: z.object({
    name: z.literal("wecomcatch"),
    version: z.string().min(1).max(40),
  }).strict(),
  source: z.object({
    id: safeIdentifier,
    watermark: z.number().int().nonnegative(),
  }).strict(),
  conversation: z.object({
    id: safeIdentifier,
    title: z.string().max(300).optional(),
  }).strict(),
  timeRange: z.object({
    start: timestamp.nullable(),
    end: timestamp.nullable(),
    timezone: z.literal("Asia/Shanghai"),
  }).strict(),
  completeness: z.object({
    archiveStatus: z.string().min(1).max(80),
    sourceMessageCount: z.number().int().nonnegative(),
  }).strict(),
  classification: z.object({
    worthProcessing: z.boolean(),
    decision: z.string().min(1).max(80),
    reasons: z.array(z.string().min(1).max(120)).max(20),
    classifier: z.string().min(1).max(120),
  }).strict(),
  messages: z.array(WccMessageSchema).min(1).max(80),
  sourceFingerprint: sha256Fingerprint,
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, message] of value.messages.entries()) {
    if (seen.has(message.id)) {
      context.addIssue({
        code: "custom",
        path: ["messages", index, "id"],
        message: "消息 ID 不得重复",
      });
    }
    seen.add(message.id);
  }
  if (value.timeRange.start && value.timeRange.end) {
    if (Date.parse(value.timeRange.start) > Date.parse(value.timeRange.end)) {
      context.addIssue({
        code: "custom",
        path: ["timeRange"],
        message: "起始时间不得晚于结束时间",
      });
    }
  }
});

export const SAFE_RECEIPT_CODES = [
  "unsupported_contract",
  "invalid_package",
  "hash_mismatch",
  "package_conflict",
  "evidence_mismatch",
  "service_unavailable",
  "internal_error",
] as const;

export const StudentTrackReceiptV1Schema = z.object({
  contractVersion: z.literal("student-track.wecom-receipt.v1"),
  receiptId: safeIdentifier,
  packageId: safeIdentifier,
  packageSha256: sha256,
  processedAt: timestamp,
  consumerVersion: z.string().min(1).max(40),
  status: z.enum(["accepted", "duplicate", "rejected", "retryable_failure"]),
  outcome: z.enum(["pending_review", "no_value"]).optional(),
  code: z.enum(SAFE_RECEIPT_CODES).optional(),
}).strict().superRefine((value, context) => {
  if (["accepted", "duplicate"].includes(value.status) && !value.outcome) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "成功回执必须包含 outcome" });
  }
  if (["rejected", "retryable_failure"].includes(value.status) && !value.code) {
    context.addIssue({ code: "custom", path: ["code"], message: "失败回执必须包含安全错误码" });
  }
});

export type WccStudentTrackFileV1 = z.infer<typeof WccStudentTrackFileV1Schema>;
export type StudentTrackReceiptV1 = z.infer<typeof StudentTrackReceiptV1Schema>;

export function packageFileSha256(rawFile: string | Uint8Array) {
  return createHash("sha256").update(rawFile).digest("hex");
}

export function handoffIdempotencyKey(sourceId: string, packageId: string, fileSha256: string) {
  return `${sourceId}:${packageId}:${sha256.parse(fileSha256)}`;
}

export function comparePackageIdentity(previousSha256: string | null, nextSha256: string) {
  const validated = sha256.parse(nextSha256);
  if (!previousSha256) return "new" as const;
  return sha256.parse(previousSha256) === validated ? "duplicate" as const : "conflict" as const;
}
