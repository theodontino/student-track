import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const extraction = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/services/wecom-handoff-extraction-service", () => ({
  generateWeComBridgeJson: extraction.generate,
  WeComExtractionError: class WeComExtractionError extends Error {
    code = "provider_error";
  },
}));

import { prisma } from "@/lib/prisma";
import {
  actOnWccHandoffPackage,
  getWccHandoffPackageDetails,
  listWccHandoffPackages,
  previewWccPendingAlignmentRecovery,
  recoverWccPendingAlignments,
  retryWccHandoffPackages,
  scanAndConsumeWccPackages,
} from "@/services/wecom-file-handoff-service";
import { previewWccHandoffReceiptRepair } from "@/services/wecom-handoff-receipt-repair-service";
import { assignWccDraftSession } from "@/services/wecom-handoff-consumer-service";
import { processDraftReview } from "@/services/review-service";

let exchangeRoot = "";

function packagePayload(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "wcc.student-track-file.v1",
    packageId: "pkg-no-value",
    producedAt: "2026-07-26T10:00:00+08:00",
    producer: { name: "wecomcatch", version: "0.2.0" },
    source: { id: "source-test", watermark: 1 },
    conversation: { id: "conversation-test", title: "合成会话" },
    timeRange: {
      start: "2026-07-26T10:00:00+08:00",
      end: "2026-07-26T10:00:00+08:00",
      timezone: "Asia/Shanghai",
    },
    completeness: { archiveStatus: "complete", sourceMessageCount: 1 },
    classification: {
      worthProcessing: false,
      decision: "archived_only",
      reasons: ["synthetic_no_value"],
      classifier: "test",
    },
    messages: [{ id: "message-test", content: "固定合成消息" }],
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

async function publishSynthetic(payload = packagePayload()) {
  const directory = path.join(exchangeRoot, "v1", "packages", "source-test");
  await mkdir(directory, { recursive: true });
  const raw = `${JSON.stringify(payload, null, 2)}\n`;
  const digest = createHash("sha256").update(raw).digest("hex");
  await writeFile(path.join(directory, `${payload.packageId}.json`), raw);
  await writeFile(path.join(directory, `${payload.packageId}.sha256`), `${digest}\n`);
  return digest;
}

beforeEach(async () => {
  exchangeRoot = await mkdtemp(path.join(os.tmpdir(), "student-track-handoff-test-"));
  process.env.STUDENT_TRACK_WCC_EXCHANGE_ROOT = exchangeRoot;
  extraction.generate.mockReset();
  await prisma.weComHandoffPackage.deleteMany();
});

afterEach(async () => {
  await prisma.communicationPreferenceCandidate.deleteMany({ where: { sourceType: "communication" } });
  await prisma.communication.deleteMany({ where: { sourceKey: { startsWith: "draft:wcc-" } } });
  await prisma.draftRecord.deleteMany({ where: { id: { startsWith: "wcc-" } } });
  await prisma.weComHandoffPackage.deleteMany();
  await prisma.semester.deleteMany({ where: { id: { startsWith: "test-handoff-" } } });
  delete process.env.STUDENT_TRACK_WCC_EXCHANGE_ROOT;
  await rm(exchangeRoot, { recursive: true, force: true });
});

describe("WCC file handoff consumer", () => {
  it("accepts a completed no-value package, records a ledger and writes a safe receipt", async () => {
    const digest = await publishSynthetic();
    const result = await scanAndConsumeWccPackages(prisma);
    expect(result).toMatchObject({ scanned: 1, accepted: 1, failed: 0 });

    const listed = await listWccHandoffPackages(prisma);
    expect(listed.items[0]).toMatchObject({
      packageId: "pkg-no-value",
      sourceId: "source-test",
      status: "no_value",
      outcome: "no_value",
      messageCount: 1,
    });

    const receiptDir = path.join(
      exchangeRoot, "v1", "receipts", "source-test", "pkg-no-value",
    );
    const receiptNames = await readdir(receiptDir);
    expect(receiptNames).toHaveLength(1);
    const receipt = JSON.parse(await readFile(path.join(receiptDir, receiptNames[0]), "utf8"));
    expect(receipt).toMatchObject({
      contractVersion: "student-track.wecom-receipt.v1",
      packageId: "pkg-no-value",
      packageSha256: digest,
      status: "accepted",
      outcome: "no_value",
    });
    expect(JSON.stringify(receipt)).not.toContain("固定合成消息");
    expect(JSON.stringify(receipt)).not.toContain(exchangeRoot);
  });

  it("skips the same package without creating another receipt", async () => {
    await publishSynthetic();
    await scanAndConsumeWccPackages(prisma);
    const repeated = await scanAndConsumeWccPackages(prisma);
    expect(repeated.duplicates).toBe(1);
    const receiptNames = await readdir(path.join(
      exchangeRoot, "v1", "receipts", "source-test", "pkg-no-value",
    ));
    expect(receiptNames).toHaveLength(1);
  });

  it("backfills conversation identity on an old ledger without reprocessing the package", async () => {
    await publishSynthetic();
    await scanAndConsumeWccPackages(prisma);
    const item = await prisma.weComHandoffPackage.findFirstOrThrow();
    await prisma.weComHandoffPackage.update({
      where: { id: item.id },
      data: { conversationId: null },
    });

    const repeated = await scanAndConsumeWccPackages(prisma);

    expect(repeated.duplicates).toBe(1);
    await expect(prisma.weComHandoffPackage.findUniqueOrThrow({ where: { id: item.id } }))
      .resolves.toMatchObject({ conversationId: "conversation-test", status: "no_value" });
  });

  it("reads immutable package evidence for diagnostics without copying it into the ledger", async () => {
    await publishSynthetic();
    await scanAndConsumeWccPackages(prisma);
    const item = await prisma.weComHandoffPackage.findFirstOrThrow();

    await expect(getWccHandoffPackageDetails(prisma, item.id)).resolves.toMatchObject({
      id: item.id,
      packageId: "pkg-no-value",
      conversation: { title: "合成会话" },
      classification: { reasons: ["synthetic_no_value"] },
      messages: [{ id: "message-test", content: "固定合成消息" }],
    });
    await expect(prisma.weComHandoffPackage.findUniqueOrThrow({ where: { id: item.id } }))
      .resolves.toMatchObject({ status: "no_value", code: null });
  });

  it("retries failures and explicitly selected no-value packages sequentially", async () => {
    await publishSynthetic();
    await scanAndConsumeWccPackages(prisma);
    const item = await prisma.weComHandoffPackage.findFirstOrThrow();
    await prisma.weComHandoffPackage.update({
      where: { id: item.id },
      data: { status: "retryable_failure", outcome: null, code: "service_unavailable", receiptId: null },
    });

    await expect(retryWccHandoffPackages(prisma, [item.id])).resolves.toMatchObject({
      total: 1,
      recovered: 1,
      stillRetryable: 0,
      failed: 0,
      skipped: 0,
    });
    await expect(retryWccHandoffPackages(prisma, [item.id])).resolves.toMatchObject({
      total: 1,
      recovered: 1,
      skipped: 0,
    });
    await prisma.weComHandoffPackage.update({ where: { id: item.id }, data: { status: "pending_review" } });
    await expect(retryWccHandoffPackages(prisma, [item.id])).resolves.toMatchObject({ total: 1, skipped: 1 });
  });

  it("recovers a stale processing package as an explicit retryable failure", async () => {
    await publishSynthetic();
    await scanAndConsumeWccPackages(prisma);
    const item = await prisma.weComHandoffPackage.findFirstOrThrow();
    await prisma.weComHandoffPackage.update({
      where: { id: item.id },
      data: {
        status: "processing",
        outcome: null,
        receiptId: null,
        lastAttemptAt: new Date(Date.now() - 31 * 60 * 1000),
        processedAt: null,
      },
    });

    const scanned = await scanAndConsumeWccPackages(prisma);
    expect(scanned.results[0]).toMatchObject({ status: "retryable_failure", code: "internal_error" });
    await expect(prisma.weComHandoffPackage.findUniqueOrThrow({ where: { id: item.id } }))
      .resolves.toMatchObject({ status: "retryable_failure", receiptId: expect.any(String) });
  });

  it("previews receipt repair without changing the ledger or filesystem", async () => {
    await publishSynthetic();
    await scanAndConsumeWccPackages(prisma);
    const item = await prisma.weComHandoffPackage.findFirstOrThrow();
    await prisma.weComHandoffPackage.update({
      where: { id: item.id },
      data: { receiptId: null },
    });
    const receiptDir = path.join(
      exchangeRoot, "v1", "receipts", "source-test", "pkg-no-value",
    );
    const beforeFiles = await readdir(receiptDir);

    const preview = await previewWccHandoffReceiptRepair(prisma);

    expect(preview).toMatchObject({
      missingReceiptId: 1,
      eligible: 1,
      linkExisting: 1,
      createReceipt: 0,
    });
    expect((await prisma.weComHandoffPackage.findUniqueOrThrow({ where: { id: item.id } })).receiptId).toBeNull();
    expect(await readdir(receiptDir)).toEqual(beforeFiles);
  });

  it("previews a new receipt only when the validated package has no legal receipt", async () => {
    await publishSynthetic();
    await scanAndConsumeWccPackages(prisma);
    const item = await prisma.weComHandoffPackage.findFirstOrThrow();
    await prisma.weComHandoffPackage.update({
      where: { id: item.id },
      data: { receiptId: null },
    });
    await rm(path.join(exchangeRoot, "v1", "receipts"), { recursive: true, force: true });

    await expect(previewWccHandoffReceiptRepair(prisma)).resolves.toMatchObject({
      missingReceiptId: 1,
      eligible: 1,
      linkExisting: 0,
      createReceipt: 1,
    });
  });

  it("rejects a marker whose hash does not match the package", async () => {
    await publishSynthetic();
    const marker = path.join(
      exchangeRoot, "v1", "packages", "source-test", "pkg-no-value.sha256",
    );
    await writeFile(marker, `${"b".repeat(64)}\n`);
    const result = await scanAndConsumeWccPackages(prisma);
    expect(result).toMatchObject({ scanned: 1, accepted: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({ status: "rejected", code: "hash_mismatch" });
    expect(await prisma.weComHandoffPackage.findFirst()).toMatchObject({
      status: "rejected",
      code: "hash_mismatch",
      messageCount: 0,
    });
  });

  it("keeps unmatched valuable evidence for human alignment and supports explicit discard", async () => {
    await publishSynthetic(packagePayload({
      packageId: "pkg-needs-alignment",
      classification: {
        worthProcessing: true,
        decision: "communication",
        reasons: ["synthetic_feedback_value"],
        classifier: "test",
      },
    }));
    const scanned = await scanAndConsumeWccPackages(prisma);
    expect(scanned.pendingAlignment).toBe(1);
    const item = await prisma.weComHandoffPackage.findFirstOrThrow({
      where: { packageId: "pkg-needs-alignment" },
    });
    expect(item.status).toBe("pending_alignment");

    await actOnWccHandoffPackage(prisma, item.id, "discard");
    const discarded = await prisma.weComHandoffPackage.findUniqueOrThrow({ where: { id: item.id } });
    expect(discarded).toMatchObject({ status: "discarded", outcome: "no_value" });
  });

  it("completes publish, consume, teacher confirmation and receipt visibility", async () => {
    const students = (await prisma.student.findMany({
      include: { enrollments: { where: { rosterStatus: "ACTIVE" }, orderBy: { semester: { startDate: "desc" } }, select: { classId: true } } },
    })).map((candidate) => ({ ...candidate, classId: candidate.enrollments[0]?.classId ?? null }));
    const student = students.find((candidate) => (
      candidate.classId
      && students.filter((other) => candidate.name.includes(other.name)).length === 1
    ));
    expect(student?.classId).toBeTruthy();
    const session = await prisma.classSession.findFirstOrThrow({
      where: { classId: student!.classId! },
      select: { code: true, date: true, semesterId: true },
    });
    await prisma.semester.create({
      data: {
        id: "test-handoff-overlapping-semester",
        name: "合成重叠学期",
        startDate: session.date,
        endDate: session.date,
      },
    });
    extraction.generate.mockResolvedValue({
      bridgeJson: {
        records: [{
          matchedStudent: { id: student!.id, confidence: "high" },
          messageIds: ["message-test"],
          factualSummary: "家长明确偏好简短文字反馈，并接受微信电话沟通。",
          feedbackUse: { relevant: true, category: "feedback-preference", priority: "high" },
          preferenceSignals: [
            { field: "length", value: "short", messageId: "message-test", quote: "简短文字反馈" },
            { field: "deliveryChannel", value: "text", messageId: "message-test", quote: "文字反馈" },
            { field: "phoneContact", value: "accepted", messageId: "message-test", quote: "可以微信电话" },
          ],
          evidence: [{ messageId: "message-test", quote: "简短文字反馈" }],
          confidence: "high",
        }],
      },
      diagnostics: { modelName: "synthetic-model" },
    });
    await publishSynthetic(packagePayload({
      packageId: "pkg-full-handoff",
      conversation: { id: "conversation-test", title: student!.name },
      classification: {
        worthProcessing: true,
        decision: "student_related",
        reasons: ["learning_confidence"],
        classifier: "synthetic-triage",
      },
      messages: [{
        id: "message-test",
        sentAt: `${session.date}T10:00:00+08:00`,
        content: "可以微信电话，简短文字反馈即可。",
      }],
    }));

    const consumed = await scanAndConsumeWccPackages(prisma);
    expect(consumed).toMatchObject({ accepted: 1, failed: 0 });
    const draft = await prisma.draftRecord.findFirstOrThrow({
      where: { id: { startsWith: "wcc-" }, studentId: student!.id },
    });
    if (!draft.sessionCode) await assignWccDraftSession(prisma, draft.id, session.code);
    const communicationCount = await prisma.communication.count();

    await processDraftReview({ draftId: draft.id, action: "confirm" });

    expect(await prisma.communication.count()).toBe(communicationCount + 1);
    await expect(prisma.communicationPreferenceCandidate.findFirstOrThrow({
      where: { studentId: student!.id, status: "pending", sourceType: "communication" },
    })).resolves.toMatchObject({
      preferenceSnapshot: expect.stringContaining('"deliveryChannel":"text"'),
      evidenceSnapshot: expect.not.stringContaining("简短文字反馈"),
    });
    expect(await prisma.draftRecord.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({
      status: "confirmed",
    });
    const receiptFiles = await readdir(path.join(
      exchangeRoot, "v1", "receipts", "source-test", "pkg-full-handoff",
    ));
    expect(receiptFiles).toHaveLength(1);
    const receipt = JSON.parse(await readFile(path.join(
      exchangeRoot,
      "v1",
      "receipts",
      "source-test",
      "pkg-full-handoff",
      receiptFiles[0],
    ), "utf8"));
    expect(receipt).toMatchObject({ status: "accepted", outcome: "pending_review" });
    await expect(prisma.weComHandoffPackage.findFirstOrThrow({
      where: { packageId: "pkg-full-handoff" },
    })).resolves.toMatchObject({
      conversationId: "conversation-test",
      selectedStudentId: student!.id,
    });
  });

  it("reuses an explicitly confirmed student for later packages in the same conversation", async () => {
    const student = await prisma.student.findFirstOrThrow({
      where: { enrollments: { some: { rosterStatus: "ACTIVE" } } },
      include: { enrollments: { where: { rosterStatus: "ACTIVE" }, select: { classId: true } } },
    });
    const session = await prisma.classSession.findFirstOrThrow({
      where: { classId: student.enrollments[0].classId },
      select: { date: true },
    });
    extraction.generate.mockResolvedValue({
      bridgeJson: { records: [] },
      diagnostics: { modelName: "synthetic-model" },
    });
    const valuable = {
      worthProcessing: true,
      decision: "student_related",
      reasons: ["synthetic_feedback_value"],
      classifier: "test",
    };
    await publishSynthetic(packagePayload({
      packageId: "pkg-remembered-first",
      conversation: { id: "conversation-remembered", title: "不含学生姓名" },
      classification: valuable,
      messages: [{ id: "message-remembered-first", sentAt: `${session.date}T10:00:00+08:00`, content: "合成反馈一" }],
    }));
    await scanAndConsumeWccPackages(prisma);
    const first = await prisma.weComHandoffPackage.findFirstOrThrow({
      where: { packageId: "pkg-remembered-first" },
    });
    expect(first.status).toBe("pending_alignment");
    await actOnWccHandoffPackage(prisma, first.id, "align", student.id);

    await publishSynthetic(packagePayload({
      packageId: "pkg-remembered-second",
      conversation: { id: "conversation-remembered", title: "仍然不含学生姓名" },
      classification: valuable,
      messages: [{ id: "message-remembered-second", sentAt: `${session.date}T10:05:00+08:00`, content: "合成反馈二" }],
    }));
    await scanAndConsumeWccPackages(prisma);

    await expect(prisma.weComHandoffPackage.findFirstOrThrow({
      where: { packageId: "pkg-remembered-second" },
    })).resolves.toMatchObject({
      status: "no_value",
      conversationId: "conversation-remembered",
      selectedStudentId: student.id,
    });
  });

  it("previews pending alignment without writes and requires confirmation for bounded recovery", async () => {
    const student = await prisma.student.findFirstOrThrow({
      where: { enrollments: { some: { rosterStatus: "ACTIVE" } } },
      include: { enrollments: { where: { rosterStatus: "ACTIVE" }, select: { classId: true } } },
    });
    const session = await prisma.classSession.findFirstOrThrow({
      where: { classId: student.enrollments[0].classId },
      select: { date: true },
    });
    const payload = packagePayload({
      packageId: "pkg-recovery-preview",
      conversation: { id: "conversation-recovery", title: student.name },
      classification: {
        worthProcessing: true,
        decision: "student_related",
        reasons: ["synthetic_feedback_value"],
        classifier: "test",
      },
      messages: [{ id: "message-recovery", sentAt: `${session.date}T10:00:00+08:00`, content: "合成反馈" }],
    });
    const digest = await publishSynthetic(payload);
    const ledger = await prisma.weComHandoffPackage.create({
      data: {
        sourceId: "source-test",
        conversationId: "conversation-recovery",
        packageId: "pkg-recovery-preview",
        packageSha256: digest,
        status: "pending_alignment",
        outcome: "pending_review",
        messageCount: 1,
        producedAt: new Date("2026-07-26T10:00:00+08:00"),
      },
    });

    await expect(previewWccPendingAlignmentRecovery(prisma)).resolves.toMatchObject({
      total: 1,
      inspected: 1,
      eligible: 1,
      manual: 0,
    });
    await expect(prisma.weComHandoffPackage.findUniqueOrThrow({ where: { id: ledger.id } }))
      .resolves.toMatchObject({ status: "pending_alignment", selectedStudentId: null });
    await expect(recoverWccPendingAlignments(prisma, "WRONG"))
      .rejects.toThrow("confirmation_required");

    extraction.generate.mockResolvedValue({
      bridgeJson: { records: [] },
      diagnostics: { modelName: "synthetic-model" },
    });
    await expect(recoverWccPendingAlignments(
      prisma,
      "REPROCESS_MATCHABLE_HANDOFFS",
      25,
    )).resolves.toMatchObject({ attempted: 1, recovered: 1, failed: 0 });
    await expect(prisma.weComHandoffPackage.findUniqueOrThrow({ where: { id: ledger.id } }))
      .resolves.toMatchObject({ status: "no_value", selectedStudentId: student.id });
  });

  it("does not allow WCC confirmation to change its evidence, student, or missing session", async () => {
    const student = await prisma.student.findFirstOrThrow();
    const draft = await prisma.draftRecord.create({
      data: {
        id: "wcc-locked-review",
        rawText: "{}",
        parsedResult: JSON.stringify({
          students: [{
            name: student.name,
            scores: { A: null, B: null, C: null },
            events: [],
            communication: { type: "家长", summary: "合成沟通" },
          }],
        }),
        studentId: student.id,
      },
    });

    await expect(processDraftReview({ draftId: draft.id, action: "confirm" }))
      .rejects.toThrow("必须先绑定学生和课次");
    await expect(processDraftReview({
      draftId: draft.id,
      action: "confirm",
      edits: { students: [] },
    })).rejects.toThrow("不支持编辑后确认");
    await expect(prisma.draftRecord.findUniqueOrThrow({ where: { id: draft.id } }))
      .resolves.toMatchObject({ status: "pending" });
  });

  it("applies a confirmed .r2 correction once and leaves rejected corrections unchanged", async () => {
    const studentRow = await prisma.student.findFirstOrThrow({
      where: { enrollments: { some: { rosterStatus: "ACTIVE" } } },
      include: { enrollments: { where: { rosterStatus: "ACTIVE" }, orderBy: { semester: { startDate: "desc" } }, select: { classId: true } } },
    });
    const student = { ...studentRow, classId: studentRow.enrollments[0]?.classId ?? null };
    const session = await prisma.classSession.findFirstOrThrow({
      where: { classId: student.classId },
      select: { id: true, code: true, date: true },
    });
    extraction.generate
      .mockResolvedValueOnce({
        bridgeJson: {
          records: [{
            matchedStudent: { id: student.id, confidence: "high" },
            messageIds: ["message-original"],
            factualSummary: "家长反馈学生做题时容易着急。",
            feedbackUse: { relevant: true, category: "parent-concern", priority: "high" },
            evidence: [{ messageId: "message-original", quote: "做题时容易着急" }],
          }],
        },
        diagnostics: { modelName: "synthetic-model" },
      })
      .mockResolvedValueOnce({
        bridgeJson: {
          records: [{
            matchedStudent: { id: student.id, confidence: "high" },
            messageIds: ["message-revised"],
            factualSummary: "家长澄清学生只是在限时练习时容易着急。",
            feedbackUse: { relevant: true, category: "parent-concern", priority: "high" },
            evidence: [{ messageId: "message-revised", quote: "只在限时练习时着急" }],
          }],
        },
        diagnostics: { modelName: "synthetic-model" },
      });
    await publishSynthetic(packagePayload({
      packageId: "pkg-correction",
      conversation: { id: "conversation-correction", title: student.name },
      classification: {
        worthProcessing: true,
        decision: "student_related",
        reasons: ["parent_concern"],
        classifier: "synthetic-triage",
      },
      messages: [{
        id: "message-original",
        sentAt: `${session.date}T10:00:00+08:00`,
        content: "做题时容易着急",
      }],
    }));
    await scanAndConsumeWccPackages(prisma);
    const originalDraft = await prisma.draftRecord.findFirstOrThrow({
      where: { handoffPackage: { packageId: "pkg-correction" } },
    });
    if (!originalDraft.sessionCode) {
      await assignWccDraftSession(prisma, originalDraft.id, session.code);
    }
    await processDraftReview({ draftId: originalDraft.id, action: "confirm" });
    const originalCommunication = await prisma.communication.findUniqueOrThrow({
      where: { sourceKey: `draft:${originalDraft.id}:${student.id}` },
    });
    const originalSourceKey = originalCommunication.sourceKey;

    await publishSynthetic(packagePayload({
      packageId: "pkg-correction.r2",
      conversation: { id: "conversation-correction", title: student.name },
      classification: {
        worthProcessing: true,
        decision: "student_related",
        reasons: ["parent_concern"],
        classifier: "synthetic-triage",
      },
      messages: [{
        id: "message-revised",
        sentAt: `${session.date}T10:05:00+08:00`,
        content: "只在限时练习时着急",
      }],
    }));
    await scanAndConsumeWccPackages(prisma);
    const correction = await prisma.draftRecord.findFirstOrThrow({
      where: { handoffPackage: { packageId: "pkg-correction.r2" } },
    });
    expect(correction).toMatchObject({
      kind: "correction",
      supersedesDraftId: originalDraft.id,
      communicationId: originalCommunication.id,
      status: "pending",
    });
    expect(await prisma.communication.findUniqueOrThrow({
      where: { id: originalCommunication.id },
    })).toMatchObject({ summary: originalCommunication.summary, sourceKey: originalSourceKey });

    if (!correction.sessionCode) await assignWccDraftSession(prisma, correction.id, session.code);
    await prisma.studentClassEnrollment.updateMany({
      where: { studentId: student.id, semesterId: (await prisma.classSession.findUniqueOrThrow({ where: { id: session.id }, select: { semesterId: true } })).semesterId },
      data: { rosterStatus: "INACTIVE", statusEffectiveAt: new Date() },
    });
    await processDraftReview({ draftId: correction.id, action: "confirm" });
    await prisma.studentClassEnrollment.updateMany({
      where: { studentId: student.id, semesterId: (await prisma.classSession.findUniqueOrThrow({ where: { id: session.id }, select: { semesterId: true } })).semesterId },
      data: { rosterStatus: "ACTIVE", statusEffectiveAt: new Date() },
    });
    const revisedCommunication = await prisma.communication.findUniqueOrThrow({
      where: { id: originalCommunication.id },
    });
    expect(revisedCommunication.summary).toContain("只是在限时练习时容易着急");
    expect(revisedCommunication.sourceKey).toBe(originalSourceKey);
    expect(await prisma.communicationRevision.findMany({
      where: { communicationId: originalCommunication.id },
    })).toHaveLength(1);
    await expect(processDraftReview({ draftId: correction.id, action: "confirm" }))
      .resolves.toMatchObject({
        status: "confirmed",
        warnings: [expect.stringContaining("重复请求未再次更新")],
      });
    expect(await prisma.communicationRevision.findMany({
      where: { communicationId: originalCommunication.id },
    })).toHaveLength(1);

    const rejected = await prisma.draftRecord.create({
      data: {
        id: "wcc-rejected-correction",
        rawText: "{}",
        parsedResult: JSON.stringify({
          students: [{
            name: student.name,
            scores: { A: null, B: null, C: null },
            events: [],
            communication: { type: "家长", summary: "不应写入的再次修订" },
          }],
        }),
        status: "pending",
        kind: "correction",
        studentId: student.id,
        sessionCode: session.code,
        supersedesDraftId: correction.id,
        communicationId: originalCommunication.id,
      },
    });
    await processDraftReview({ draftId: rejected.id, action: "reject" });
    expect(await prisma.communication.findUniqueOrThrow({
      where: { id: originalCommunication.id },
    })).toMatchObject({ summary: revisedCommunication.summary, sourceKey: originalSourceKey });
    expect(await prisma.communicationRevision.findMany({
      where: { communicationId: originalCommunication.id },
    })).toHaveLength(1);

    await publishSynthetic(packagePayload({
      packageId: "pkg-correction.r3",
      conversation: { id: "conversation-correction", title: student.name },
      classification: {
        worthProcessing: false,
        decision: "irrelevant",
        reasons: ["retracted"],
        classifier: "synthetic-triage",
      },
      messages: [{
        id: "message-retracted",
        sentAt: `${session.date}T10:10:00+08:00`,
        content: "该消息与学生反馈无关",
      }],
    }));
    await scanAndConsumeWccPackages(prisma);
    expect(await prisma.weComHandoffPackage.findFirstOrThrow({
      where: { packageId: "pkg-correction.r3" },
    })).toMatchObject({ status: "pending_lineage", outcome: "pending_review" });
    expect(await prisma.draftRecord.findMany({
      where: { handoffPackage: { packageId: "pkg-correction.r3" } },
    })).toHaveLength(0);
    expect(await prisma.communication.findUniqueOrThrow({
      where: { id: originalCommunication.id },
    })).toMatchObject({ summary: revisedCommunication.summary, sourceKey: originalSourceKey });
  });
});
