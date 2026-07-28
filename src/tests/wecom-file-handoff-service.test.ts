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
  listWccHandoffPackages,
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
  await prisma.communication.deleteMany({ where: { sourceKey: { startsWith: "draft:wcc-" } } });
  await prisma.draftRecord.deleteMany({ where: { id: { startsWith: "wcc-" } } });
  await prisma.weComHandoffPackage.deleteMany();
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
    const students = await prisma.student.findMany({
      select: { id: true, name: true, classId: true },
    });
    const student = students.find((candidate) => (
      candidate.classId
      && students.filter((other) => candidate.name.includes(other.name)).length === 1
    ));
    expect(student?.classId).toBeTruthy();
    const session = await prisma.classSession.findFirstOrThrow({
      where: { classId: student!.classId! },
      select: { code: true, date: true },
    });
    extraction.generate.mockResolvedValue({
      bridgeJson: {
        records: [{
          matchedStudent: { id: student!.id, confidence: "high" },
          messageIds: ["message-test"],
          factualSummary: "家长反馈学生近期学习信心有所改善。",
          feedbackUse: { relevant: true, category: "learning-confidence", priority: "high" },
          evidence: [{ messageId: "message-test", quote: "近期学习信心有所改善" }],
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
        content: "近期学习信心有所改善",
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
});
