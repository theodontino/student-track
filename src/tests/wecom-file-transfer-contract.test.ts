import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  comparePackageIdentity,
  handoffIdempotencyKey,
  packageFileSha256,
  StudentTrackReceiptV1Schema,
  WccStudentTrackFileV1Schema,
} from "@/lib/contracts/wecom-file-transfer";

const examples = path.resolve(process.cwd(), "docs/contracts/examples");

describe("WCC local file handoff contract", () => {
  it("accepts the synthetic package and receipt examples", async () => {
    const packageJson = JSON.parse(await readFile(path.join(examples, "wcc-student-track-file-v1.json"), "utf8"));
    const receiptJson = JSON.parse(await readFile(path.join(examples, "student-track-receipt-v1.json"), "utf8"));
    expect(WccStudentTrackFileV1Schema.parse(packageJson).messages).toHaveLength(1);
    expect(StudentTrackReceiptV1Schema.parse(receiptJson).status).toBe("accepted");
  });

  it("rejects unknown versions, duplicate message ids, invalid time and oversized packages", () => {
    const base = {
      contractVersion: "wcc.student-track-file.v1",
      packageId: "pkg-1",
      producedAt: "2026-07-26T10:00:00+08:00",
      producer: { name: "wecomcatch", version: "0.2.0" },
      source: { id: "source-1", watermark: 1 },
      conversation: { id: "conversation-1" },
      timeRange: { start: "2026-07-26T10:00:00+08:00", end: "2026-07-26T10:01:00+08:00", timezone: "Asia/Shanghai" },
      completeness: { archiveStatus: "complete", sourceMessageCount: 1 },
      classification: { worthProcessing: true, decision: "untriaged", reasons: [], classifier: "test" },
      messages: [{ id: "message-1", content: "固定合成消息" }],
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
    };
    expect(WccStudentTrackFileV1Schema.safeParse({ ...base, contractVersion: "wcc.student-track-file.v2" }).success).toBe(false);
    expect(WccStudentTrackFileV1Schema.safeParse({ ...base, messages: [base.messages[0], base.messages[0]] }).success).toBe(false);
    expect(WccStudentTrackFileV1Schema.safeParse({ ...base, producedAt: "not-a-date" }).success).toBe(false);
    expect(WccStudentTrackFileV1Schema.safeParse({ ...base, messages: Array.from({ length: 81 }, (_, index) => ({ id: `message-${index}`, content: "合成" })) }).success).toBe(false);
  });

  it("provides deterministic hash, idempotency and conflict behavior", () => {
    const hash = packageFileSha256('{"synthetic":true}\n');
    expect(hash).toHaveLength(64);
    expect(handoffIdempotencyKey("source-1", "pkg-1", hash)).toBe(`source-1:pkg-1:${hash}`);
    expect(comparePackageIdentity(null, hash)).toBe("new");
    expect(comparePackageIdentity(hash, hash)).toBe("duplicate");
    expect(comparePackageIdentity(hash, "b".repeat(64))).toBe("conflict");
  });

  it("keeps receipt diagnostics on an allowlist", () => {
    const result = StudentTrackReceiptV1Schema.safeParse({
      contractVersion: "student-track.wecom-receipt.v1",
      receiptId: "receipt-1",
      packageId: "pkg-1",
      packageSha256: "a".repeat(64),
      processedAt: "2026-07-26T10:00:00+08:00",
      consumerVersion: "0.21.0",
      status: "rejected",
      code: "private_stack_trace",
    });
    expect(result.success).toBe(false);
  });
});
