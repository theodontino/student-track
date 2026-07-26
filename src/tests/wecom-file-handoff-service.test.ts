import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  actOnWccHandoffPackage,
  listWccHandoffPackages,
  scanAndConsumeWccPackages,
} from "@/services/wecom-file-handoff-service";

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
  await prisma.weComHandoffPackage.deleteMany();
});

afterEach(async () => {
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
});
