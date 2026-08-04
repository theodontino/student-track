import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import packageMetadata from "../../package.json";
import {
  packageFileSha256,
  StudentTrackReceiptV1Schema,
  WccStudentTrackFileV1Schema,
  type StudentTrackReceiptV1,
  type WccStudentTrackFileV1,
} from "@/lib/contracts/wecom-file-transfer";
import { consumeWccHandoffPackage } from "@/services/wecom-handoff-consumer-service";
import { WeComExtractionError } from "@/services/wecom-handoff-extraction-service";
import {
  resolveWccHandoffAlignment,
  type WccAlignmentReason,
} from "@/services/wecom-handoff-alignment-service";

const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROCESSING_STALE_AFTER_MS = 30 * 60 * 1000;
let activeScan: Promise<Awaited<ReturnType<typeof performScanAndConsume>>> | null = null;

export type HandoffAction = "retry" | "align" | "discard";

export function getWccExchangeRoot() {
  const configured = process.env.STUDENT_TRACK_WCC_EXCHANGE_ROOT?.trim();
  return configured
    ? path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir()))
    : path.join(os.homedir(), "Library", "Application Support", "WCC Student Track Exchange");
}

function packageDirectory(root = getWccExchangeRoot()) {
  return path.join(root, "v1", "packages");
}

function receiptDirectory(sourceId: string, packageId: string, root = getWccExchangeRoot()) {
  return path.join(root, "v1", "receipts", sourceId, packageId);
}

function receiptId(packageId: string) {
  return `receipt-${createHash("sha256")
    .update(`${packageId}\0${randomUUID()}`)
    .digest("hex")
    .slice(0, 24)}`;
}

async function atomicWrite(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export async function writeWccHandoffReceipt(
  sourceId: string,
  packageId: string,
  packageSha256: string,
  status: StudentTrackReceiptV1["status"],
  outcome?: StudentTrackReceiptV1["outcome"],
  code?: StudentTrackReceiptV1["code"],
) {
  const receipt = StudentTrackReceiptV1Schema.parse({
    contractVersion: "student-track.wecom-receipt.v1",
    receiptId: receiptId(packageId),
    packageId,
    packageSha256,
    processedAt: new Date().toISOString(),
    consumerVersion: packageMetadata.version,
    status,
    ...(outcome ? { outcome } : {}),
    ...(code ? { code } : {}),
  });
  const destination = path.join(
    receiptDirectory(sourceId, packageId),
    `${receipt.receiptId}.json`,
  );
  await atomicWrite(destination, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

async function attachReceiptAfterFinalization(
  prisma: PrismaClient,
  ledgerId: string,
  sourceId: string,
  packageId: string,
  packageSha256: string,
  status: StudentTrackReceiptV1["status"],
  outcome?: StudentTrackReceiptV1["outcome"],
  code?: StudentTrackReceiptV1["code"],
) {
  try {
    const receipt = await writeWccHandoffReceipt(
      sourceId, packageId, packageSha256, status, outcome, code,
    );
    await prisma.weComHandoffPackage.update({
      where: { id: ledgerId },
      data: { receiptId: receipt.receiptId },
    });
  } catch {
    // The ledger is already terminal. Receipt repair can safely fill this link later.
  }
}

async function markerFiles(root = getWccExchangeRoot()) {
  const base = packageDirectory(root);
  let sources: string[] = [];
  try {
    sources = await fs.readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const sourceId of sources.sort()) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sourceId)) continue;
    const directory = path.join(base, sourceId);
    const stat = await fs.stat(directory).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const names = await fs.readdir(directory);
    for (const name of names.sort()) {
      if (/^[A-Za-z0-9._:-]{1,160}\.sha256$/.test(name)) {
        files.push(path.join(directory, name));
      }
    }
  }
  return files;
}

async function readPackage(markerPath: string) {
  const expected = (await fs.readFile(markerPath, "utf8")).trim();
  if (!SHA256_PATTERN.test(expected)) throw new Error("hash_mismatch");
  const packagePath = markerPath.replace(/\.sha256$/, ".json");
  const stat = await fs.stat(packagePath);
  if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error("invalid_package");
  const raw = await fs.readFile(packagePath);
  const actual = packageFileSha256(raw);
  if (actual !== expected) throw new Error("hash_mismatch");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("invalid_package");
  }
  if (
    decoded
    && typeof decoded === "object"
    && "contractVersion" in decoded
    && (decoded as { contractVersion?: unknown }).contractVersion !== "wcc.student-track-file.v1"
  ) {
    throw new Error("unsupported_contract");
  }
  const parsed = WccStudentTrackFileV1Schema.safeParse(decoded);
  if (!parsed.success) throw new Error("invalid_package");
  const payload = parsed.data;
  if (path.basename(packagePath) !== `${payload.packageId}.json`) throw new Error("invalid_package");
  if (path.basename(path.dirname(packagePath)) !== payload.source.id) throw new Error("invalid_package");
  return { payload, sha256: actual };
}

function safeHandoffIdentifier(value: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("invalid_package");
  return value;
}

export function parseHandoffPackageLineage(packageId: string) {
  const match = /^(.*)\.r([2-9][0-9]*)$/.exec(packageId);
  if (!match) {
    return {
      rootPackageId: packageId,
      parentPackageId: null,
      revisionNumber: 1,
    };
  }
  const revisionNumber = Number(match[2]);
  const rootPackageId = match[1];
  return {
    rootPackageId,
    parentPackageId: revisionNumber === 2
      ? rootPackageId
      : `${rootPackageId}.r${revisionNumber - 1}`,
    revisionNumber,
  };
}

export async function readWccHandoffPackage(sourceId: string, packageId: string) {
  const marker = path.join(
    packageDirectory(),
    safeHandoffIdentifier(sourceId),
    `${safeHandoffIdentifier(packageId)}.sha256`,
  );
  return readPackage(marker);
}

export async function listWccHandoffReceipts(sourceId: string, packageId: string) {
  const directory = receiptDirectory(
    safeHandoffIdentifier(sourceId),
    safeHandoffIdentifier(packageId),
  );
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const receipts: StudentTrackReceiptV1[] = [];
  for (const name of names.sort()) {
    if (!/^[A-Za-z0-9._:-]{1,160}\.json$/.test(name)) continue;
    const raw = await fs.readFile(path.join(directory, name), "utf8").catch(() => "");
    if (!raw) continue;
    try {
      const parsed = StudentTrackReceiptV1Schema.safeParse(JSON.parse(raw));
      if (parsed.success) receipts.push(parsed.data);
    } catch {
      // Invalid historical receipt files are ignored and never overwritten.
    }
  }
  return receipts;
}

function safeFailure(error: unknown) {
  if (error instanceof WeComExtractionError) {
    if (error.code === "evidence_mismatch") {
      return { status: "rejected" as const, code: "evidence_mismatch" as const };
    }
    return { status: "retryable_failure" as const, code: "service_unavailable" as const };
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "directory_conflict") {
    return { status: "rejected" as const, code: "evidence_mismatch" as const };
  }
  if (["hash_mismatch", "invalid_package"].includes(message)) {
    return { status: "rejected" as const, code: message as "hash_mismatch" | "invalid_package" };
  }
  if (message === "unsupported_contract") {
    return { status: "rejected" as const, code: "unsupported_contract" as const };
  }
  return { status: "retryable_failure" as const, code: "internal_error" as const };
}

async function consumeValidatedPackage(
  prisma: PrismaClient,
  payload: WccStudentTrackFileV1,
  sha256: string,
  selectedStudentId?: string,
  force = false,
) {
  const lineage = parseHandoffPackageLineage(payload.packageId);
  const existingIdentity = await prisma.weComHandoffPackage.findMany({
    where: { sourceId: payload.source.id, packageId: payload.packageId },
    orderBy: { createdAt: "asc" },
  });
  let same = existingIdentity.find((item) => item.packageSha256 === sha256);
  if (same && !same.conversationId) {
    same = await prisma.weComHandoffPackage.update({
      where: { id: same.id },
      data: { conversationId: payload.conversation.id },
    });
  }
  if (same && !force && !["discovered"].includes(same.status)) {
    if (same.status === "processing") {
      const stale = !same.lastAttemptAt
        || Date.now() - same.lastAttemptAt.getTime() >= PROCESSING_STALE_AFTER_MS;
      if (stale) {
        const recovered = await prisma.weComHandoffPackage.update({
          where: { id: same.id },
          data: {
            status: "retryable_failure",
            code: "internal_error",
            outcome: null,
            receiptId: null,
            processedAt: new Date(),
          },
        });
        await attachReceiptAfterFinalization(
          prisma, recovered.id, payload.source.id, payload.packageId, sha256,
          "retryable_failure", undefined, "internal_error",
        );
        return { id: recovered.id, status: recovered.status, code: recovered.code };
      }
    }
    return { id: same.id, status: "duplicate", outcome: same.outcome };
  }
  if (existingIdentity.some((item) => item.packageSha256 !== sha256)) {
    const conflict = await prisma.weComHandoffPackage.create({
      data: {
        sourceId: payload.source.id,
        conversationId: payload.conversation.id,
        packageId: payload.packageId,
        packageSha256: sha256,
        status: "rejected",
        code: "package_conflict",
        messageCount: payload.messages.length,
        rootPackageId: lineage.rootPackageId,
        parentPackageId: lineage.parentPackageId,
        revisionNumber: lineage.revisionNumber,
        producedAt: new Date(payload.producedAt),
        processedAt: new Date(),
      },
    });
    await attachReceiptAfterFinalization(
      prisma, conflict.id, payload.source.id, payload.packageId, sha256,
      "rejected", undefined, "package_conflict",
    );
    return { id: conflict.id, status: conflict.status, code: conflict.code };
  }

  const ledger = same || await prisma.weComHandoffPackage.create({
    data: {
      sourceId: payload.source.id,
      conversationId: payload.conversation.id,
      packageId: payload.packageId,
      packageSha256: sha256,
      rootPackageId: lineage.rootPackageId,
      parentPackageId: lineage.parentPackageId,
      revisionNumber: lineage.revisionNumber,
      status: "discovered",
      messageCount: payload.messages.length,
      producedAt: new Date(payload.producedAt),
    },
  });

  let matchedStudentId = selectedStudentId;
  let lineageDraft: {
    id: string;
    status: string;
    studentId: string | null;
    communicationId: string | null;
  } | null = null;
  let revisionKind: "standard" | "replacement" | "correction" = "standard";
  if (lineage.revisionNumber > 1) {
    const [rootLedger, parentLedger] = await Promise.all([
      prisma.weComHandoffPackage.findFirst({
        where: { sourceId: payload.source.id, packageId: lineage.rootPackageId },
        orderBy: { createdAt: "asc" },
      }),
      prisma.weComHandoffPackage.findFirst({
        where: { sourceId: payload.source.id, packageId: lineage.parentPackageId! },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    if (rootLedger && parentLedger) {
      lineageDraft = await prisma.draftRecord.findFirst({
        where: {
          OR: [
            { handoffPackageId: parentLedger.id },
            { rawText: { contains: `"packageId":"${lineage.parentPackageId}"` } },
          ],
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, studentId: true, communicationId: true },
      });
      matchedStudentId = matchedStudentId || parentLedger.selectedStudentId || undefined;
      if (lineageDraft?.status === "confirmed" && !lineageDraft.communicationId && lineageDraft.studentId) {
        const communication = await prisma.communication.findUnique({
          where: { sourceKey: `draft:${lineageDraft.id}:${lineageDraft.studentId}` },
          select: { id: true },
        });
        if (communication) lineageDraft.communicationId = communication.id;
      }
      revisionKind = lineageDraft?.status === "confirmed" ? "correction" : "replacement";
    }
    if (
      !rootLedger
      || !parentLedger
      || !lineageDraft
      || (lineageDraft.status === "confirmed" && !lineageDraft.communicationId)
      || !matchedStudentId
    ) {
      const pendingLineage = await prisma.weComHandoffPackage.update({
        where: { id: ledger.id },
        data: {
          status: "pending_lineage",
          outcome: "pending_review",
          receiptId: null,
          lastAttemptAt: new Date(),
        },
      });
      await attachReceiptAfterFinalization(
        prisma, pendingLineage.id, payload.source.id, payload.packageId, sha256,
        "accepted", "pending_review",
      );
      return {
        id: pendingLineage.id,
        status: pendingLineage.status,
        outcome: pendingLineage.outcome,
      };
    }
  }

  if (!payload.classification.worthProcessing) {
    if (lineage.revisionNumber > 1) {
      // A revision that retracts the original classification can invalidate a
      // confirmed communication. Keep it in the explicit lineage queue rather
      // than silently treating it as an unrelated no-value package.
      const pendingLineage = await prisma.weComHandoffPackage.update({
        where: { id: ledger.id },
        data: {
          status: "pending_lineage",
          outcome: "pending_review",
          receiptId: null,
          lastAttemptAt: new Date(),
        },
      });
      await attachReceiptAfterFinalization(
        prisma, pendingLineage.id, payload.source.id, payload.packageId, sha256,
        "accepted", "pending_review",
      );
      return {
        id: pendingLineage.id,
        status: pendingLineage.status,
        outcome: pendingLineage.outcome,
      };
    }
    const updated = await prisma.weComHandoffPackage.update({
      where: { id: ledger.id },
      data: {
        status: "no_value",
        outcome: "no_value",
        receiptId: null,
        processedAt: new Date(),
        lastAttemptAt: new Date(),
      },
    });
    await attachReceiptAfterFinalization(
      prisma, updated.id, payload.source.id, payload.packageId, sha256, "accepted", "no_value",
    );
    return { id: updated.id, status: updated.status, outcome: updated.outcome };
  }

  const alignment = await resolveWccHandoffAlignment(prisma, {
    payload,
    selectedStudentId: matchedStudentId,
  });
  matchedStudentId = alignment.studentId || undefined;
  if (!matchedStudentId) {
    const pending = await prisma.weComHandoffPackage.update({
      where: { id: ledger.id },
      data: {
        status: "pending_alignment",
        outcome: "pending_review",
        receiptId: null,
        lastAttemptAt: new Date(),
      },
    });
    await attachReceiptAfterFinalization(
      prisma, pending.id, payload.source.id, payload.packageId, sha256, "accepted", "pending_review",
    );
    return { id: pending.id, status: pending.status, outcome: pending.outcome };
  }

  await prisma.weComHandoffPackage.update({
    where: { id: ledger.id },
    data: {
      status: "processing",
      conversationId: payload.conversation.id,
      selectedStudentId: matchedStudentId,
      lastAttemptAt: new Date(),
    },
  });
  try {
    const result = await consumeWccHandoffPackage(prisma, payload, matchedStudentId, {
      handoffPackageId: ledger.id,
      kind: revisionKind,
      supersedesDraftId: lineageDraft?.id,
      communicationId: revisionKind === "correction" ? lineageDraft?.communicationId ?? undefined : undefined,
    });
    if (
      lineage.revisionNumber > 1
      && lineageDraft?.status === "pending"
      && result.drafts.length > 0
    ) {
      await prisma.draftRecord.updateMany({
        where: { id: lineageDraft.id, status: "pending" },
        data: { status: "superseded" },
      });
    }
    const outcome = result.status === "pending_review" ? "pending_review" : "no_value";
    const updated = await prisma.weComHandoffPackage.update({
      where: { id: ledger.id },
      data: {
        status: outcome,
        outcome,
        receiptId: null,
        processedAt: new Date(),
        code: null,
      },
    });
    await attachReceiptAfterFinalization(
      prisma, updated.id, payload.source.id, payload.packageId, sha256, "accepted", outcome,
    );
    return { id: updated.id, status: updated.status, outcome, draftCount: result.drafts.length };
  } catch (error) {
    const failure = safeFailure(error);
    const updated = await prisma.weComHandoffPackage.update({
      where: { id: ledger.id },
      data: {
        status: failure.status,
        code: failure.code,
        receiptId: null,
        processedAt: new Date(),
      },
    });
    await attachReceiptAfterFinalization(
      prisma, updated.id, payload.source.id, payload.packageId, sha256,
      failure.status, undefined, failure.code,
    );
    return { id: updated.id, status: updated.status, code: updated.code };
  }
}

async function performScanAndConsume(prisma: PrismaClient, limit = 20) {
  // 取所有 marker，按 DB 已有记录的 marker 排在后面，再截前 `limit`。
  // 这样能跳过已处理过的前 N 个，把新包送进处理路径。
  const allMarkers = await markerFiles();
  const seen = await prisma.weComHandoffPackage.findMany({
    select: { sourceId: true, packageId: true, packageSha256: true, conversationId: true },
  });
  const seenIdentities = new Set(seen.map((row) => `${row.sourceId}/${row.packageId}`));
  const needsConversationBackfill = new Set(seen
    .filter((row) => !row.conversationId)
    .map((row) => `${row.sourceId}/${row.packageId}`));
  const markerIdentity = (marker: string) => `${path.basename(path.dirname(marker))}/${path.basename(marker, ".sha256")}`;
  const ordered = [
    ...allMarkers.filter((marker) => !seenIdentities.has(markerIdentity(marker))),
    ...allMarkers.filter((marker) => needsConversationBackfill.has(markerIdentity(marker))),
    ...allMarkers.filter((marker) => seenIdentities.has(markerIdentity(marker)) && !needsConversationBackfill.has(markerIdentity(marker))),
  ];
  const cap = Math.max(1, Math.min(limit, 100));
  const markers = ordered.slice(0, cap);
  const results = [];
  for (const marker of markers) {
    try {
      const { payload, sha256 } = await readPackage(marker);
      results.push(await consumeValidatedPackage(prisma, payload, sha256));
    } catch (error) {
      const failure = safeFailure(error);
      const sourceId = path.basename(path.dirname(marker));
      const packageId = path.basename(marker, ".sha256");
      let digest = "0".repeat(64);
      try {
        digest = packageFileSha256(await fs.readFile(marker.replace(/\.sha256$/, ".json")));
      } catch {
        // A missing or unreadable JSON file remains represented by an all-zero
        // digest; no raw path or content is stored.
      }
      const existing = await prisma.weComHandoffPackage.findFirst({
        where: { sourceId, packageId, packageSha256: digest },
      });
      if (!existing) {
        const rejected = await prisma.weComHandoffPackage.create({
          data: {
            sourceId,
            packageId,
            packageSha256: digest,
            status: "rejected",
            code: failure.code,
            messageCount: 0,
            producedAt: new Date(),
            processedAt: new Date(),
          },
        });
        await attachReceiptAfterFinalization(
          prisma, rejected.id, sourceId, packageId, digest,
          "rejected", undefined, failure.code,
        );
      }
      results.push({ status: "rejected", code: failure.code });
    }
  }
  return {
    scanned: markers.length,
    accepted: results.filter((item) => ["pending_review", "no_value"].includes(item.status)).length,
    pendingAlignment: results.filter((item) => item.status === "pending_alignment").length,
    failed: results.filter((item) => ["rejected", "retryable_failure"].includes(item.status)).length,
    duplicates: results.filter((item) => item.status === "duplicate").length,
    results,
  };
}

export function scanAndConsumeWccPackages(prisma: PrismaClient, limit = 20) {
  if (activeScan) return activeScan;
  activeScan = performScanAndConsume(prisma, limit).finally(() => {
    activeScan = null;
  });
  return activeScan;
}

export async function listWccHandoffPackages(prisma: PrismaClient) {
  const [items, students] = await Promise.all([
    prisma.weComHandoffPackage.findMany({
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: {
        selectedStudent: { select: { id: true, name: true, studentId: true } },
      },
    }),
    prisma.student.findMany({
      where: { enrollments: { some: { rosterStatus: "ACTIVE" } } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, studentId: true },
    }),
  ]);
  return {
    items: items.map((item) => ({
      id: item.id,
      packageId: item.packageId,
      rootPackageId: item.rootPackageId,
      parentPackageId: item.parentPackageId,
      revisionNumber: item.revisionNumber,
      sourceId: item.sourceId,
      status: item.status,
      outcome: item.outcome,
      code: item.code,
      messageCount: item.messageCount,
      selectedStudent: item.selectedStudent,
      producedAt: item.producedAt,
      updatedAt: item.updatedAt,
    })),
    students,
  };
}

async function packageForLedger(prisma: PrismaClient, id: string) {
  const item = await prisma.weComHandoffPackage.findUnique({ where: { id } });
  if (!item) throw new Error("package_not_found");
  const marker = path.join(
    packageDirectory(),
    item.sourceId,
    `${item.packageId}.sha256`,
  );
  const loaded = await readPackage(marker);
  if (loaded.sha256 !== item.packageSha256) throw new Error("package_conflict");
  return { item, ...loaded };
}

/** Read-only, package-level evidence for teacher diagnostics. */
export async function getWccHandoffPackageDetails(prisma: PrismaClient, id: string) {
  const { item, payload, sha256 } = await packageForLedger(prisma, id);
  return {
    id: item.id,
    packageId: item.packageId,
    sourceId: item.sourceId,
    packageSha256: sha256,
    status: item.status,
    outcome: item.outcome,
    code: item.code,
    conversation: payload.conversation,
    timeRange: payload.timeRange,
    classification: payload.classification,
    messages: payload.messages.map((message) => ({
      id: message.id,
      sentAt: message.sentAt,
      sender: message.sender,
      direction: message.direction,
      type: message.type,
      content: message.content,
      timeContext: message.timeContext,
      confidence: message.confidence,
    })),
  };
}

/**
 * Bounded, sequential retry for a selected group of recoverable packages.
 * The extraction role may target a local model, so parallel retries would make
 * diagnosis worse and can exhaust the provider while hiding the first error.
 */
export async function retryWccHandoffPackages(
  prisma: PrismaClient,
  ids: string[],
) {
  const selected = [...new Set(ids.filter(Boolean))].slice(0, 25);
  const results: Array<{ id: string; status: string; code?: string | null; error?: string }> = [];
  for (const id of selected) {
    const current = await prisma.weComHandoffPackage.findUnique({
      where: { id },
      select: {
        status: true,
        drafts: { select: { status: true, parsedResult: true } },
      },
    });
    if (!current) {
      results.push({ id, status: "skipped", error: "package_not_found" });
      continue;
    }
    const pendingPreferenceEnrichment = current.status === "pending_review"
      && current.drafts.some((draft) => {
        if (draft.status !== "pending") return false;
        try {
          const source = (JSON.parse(draft.parsedResult) as { wccSource?: {
            classification?: { reasons?: unknown };
            preferenceSignals?: unknown;
          } }).wccSource;
          return Array.isArray(source?.classification?.reasons)
            && source.classification.reasons.includes("feedback_category_feedback_preference")
            && (!Array.isArray(source.preferenceSignals) || source.preferenceSignals.length === 0);
        } catch {
          return false;
        }
      });
    if (!["retryable_failure", "no_value"].includes(current.status) && !pendingPreferenceEnrichment) {
      results.push({ id, status: "skipped", error: "not_retryable" });
      continue;
    }
    try {
      const result = await actOnWccHandoffPackage(prisma, id, "retry");
      results.push({ id, status: result.status, code: result.code });
    } catch (error) {
      results.push({
        id,
        status: "failed",
        error: error instanceof Error ? error.message : "handoff_action_failed",
      });
    }
  }
  return {
    total: selected.length,
    recovered: results.filter((item) => ["pending_review", "no_value", "pending_alignment"].includes(item.status)).length,
    stillRetryable: results.filter((item) => item.status === "retryable_failure").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    results,
  };
}

type PendingAlignmentInspection = {
  id: string;
  studentId: string | null;
  reason: WccAlignmentReason | "package_unavailable";
};

async function inspectPendingAlignments(
  prisma: PrismaClient,
  inspectionLimit = 200,
): Promise<{ total: number; items: PendingAlignmentInspection[] }> {
  const [total, pending] = await Promise.all([
    prisma.weComHandoffPackage.count({ where: { status: "pending_alignment" } }),
    prisma.weComHandoffPackage.findMany({
      where: { status: "pending_alignment" },
      orderBy: { updatedAt: "asc" },
      take: Math.max(1, Math.min(inspectionLimit, 500)),
      select: { id: true },
    }),
  ]);
  const items: PendingAlignmentInspection[] = [];
  for (const row of pending) {
    try {
      const loaded = await packageForLedger(prisma, row.id);
      const alignment = await resolveWccHandoffAlignment(prisma, { payload: loaded.payload });
      items.push({ id: row.id, studentId: alignment.studentId, reason: alignment.reason });
    } catch {
      items.push({ id: row.id, studentId: null, reason: "package_unavailable" });
    }
  }
  return { total, items };
}

/** Read-only classification of pending alignment rows; no package is retried. */
export async function previewWccPendingAlignmentRecovery(prisma: PrismaClient) {
  const inspected = await inspectPendingAlignments(prisma);
  const eligible = inspected.items.filter((item) => Boolean(item.studentId));
  const reasons = inspected.items.reduce<Record<string, number>>((counts, item) => {
    if (!item.studentId) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    return counts;
  }, {});
  return {
    total: inspected.total,
    inspected: inspected.items.length,
    eligible: eligible.length,
    manual: inspected.items.length - eligible.length,
    uninspected: Math.max(0, inspected.total - inspected.items.length),
    reasons,
  };
}

/**
 * Explicitly confirmed and bounded recovery. Matching is revalidated immediately
 * before the existing extraction pipeline runs; no manual-only row is changed.
 */
export async function recoverWccPendingAlignments(
  prisma: PrismaClient,
  confirmation: string,
  limit = 25,
) {
  if (confirmation !== "REPROCESS_MATCHABLE_HANDOFFS") throw new Error("confirmation_required");
  const cap = Math.max(1, Math.min(limit, 25));
  const inspected = await inspectPendingAlignments(prisma);
  const eligible = inspected.items.filter(
    (item): item is PendingAlignmentInspection & { studentId: string } => Boolean(item.studentId),
  ).slice(0, cap);
  const results: Array<{ id: string; status: string; code?: string | null; error?: string }> = [];
  for (const item of eligible) {
    try {
      const loaded = await packageForLedger(prisma, item.id);
      const revalidated = await resolveWccHandoffAlignment(prisma, { payload: loaded.payload });
      if (!revalidated.studentId || revalidated.studentId !== item.studentId) {
        results.push({ id: item.id, status: "skipped", error: "alignment_changed" });
        continue;
      }
      const result = await consumeValidatedPackage(
        prisma,
        loaded.payload,
        loaded.sha256,
        item.studentId,
        true,
      );
      results.push({ id: item.id, status: result.status, code: "code" in result ? result.code : null });
    } catch (error) {
      results.push({
        id: item.id,
        status: "failed",
        error: error instanceof Error ? error.message : "handoff_action_failed",
      });
    }
  }
  return {
    attempted: eligible.length,
    recovered: results.filter((item) => ["pending_review", "no_value"].includes(item.status)).length,
    stillPending: results.filter((item) => item.status === "pending_alignment").length,
    failed: results.filter((item) => item.status === "failed" || ["retryable_failure", "rejected"].includes(item.status)).length,
    skipped: results.filter((item) => item.status === "skipped").length,
    remainingEligible: Math.max(0, inspected.items.filter((item) => Boolean(item.studentId)).length - eligible.length),
    manual: inspected.items.filter((item) => !item.studentId).length,
    results,
  };
}

export async function actOnWccHandoffPackage(
  prisma: PrismaClient,
  id: string,
  action: HandoffAction,
  studentId?: string,
) {
  if (action === "discard") {
    const current = await prisma.weComHandoffPackage.findUnique({ where: { id } });
    if (!current) throw new Error("package_not_found");
    if (current.status === "rejected") {
      return prisma.weComHandoffPackage.update({
        where: { id },
        data: {
          status: "discarded",
          outcome: "no_value",
          processedAt: new Date(),
          lastAttemptAt: new Date(),
        },
      });
    }
  }
  const loaded = await packageForLedger(prisma, id);
  if (action === "discard") {
    const discarded = await prisma.weComHandoffPackage.update({
      where: { id },
      data: {
        status: "discarded",
        outcome: "no_value",
        code: null,
        receiptId: null,
        processedAt: new Date(),
        lastAttemptAt: new Date(),
      },
    });
    await attachReceiptAfterFinalization(
      prisma, discarded.id, loaded.payload.source.id, loaded.payload.packageId, loaded.sha256,
      "accepted", "no_value",
    );
    return discarded;
  }
  if (action === "align" && !studentId) throw new Error("student_required");
  return consumeValidatedPackage(
    prisma,
    loaded.payload,
    loaded.sha256,
    studentId || loaded.item.selectedStudentId || undefined,
    true,
  );
}
