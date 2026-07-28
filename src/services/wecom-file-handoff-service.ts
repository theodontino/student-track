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

const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
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

function exactTitleMatches(
  title: string | undefined,
  students: Array<{ id: string; name: string; studentId: string; classId: string }>,
) {
  const normalized = (title || "").trim();
  if (!normalized) return [];
  return students.filter((student) => normalized.includes(student.name));
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
  const existingIdentity = await prisma.weComHandoffPackage.findMany({
    where: { sourceId: payload.source.id, packageId: payload.packageId },
    orderBy: { createdAt: "asc" },
  });
  const same = existingIdentity.find((item) => item.packageSha256 === sha256);
  if (same && !force && !["discovered"].includes(same.status)) {
    return { id: same.id, status: "duplicate", outcome: same.outcome };
  }
  if (existingIdentity.some((item) => item.packageSha256 !== sha256)) {
    const receipt = await writeWccHandoffReceipt(
      payload.source.id, payload.packageId, sha256, "rejected", undefined, "package_conflict",
    );
    const conflict = await prisma.weComHandoffPackage.create({
      data: {
        sourceId: payload.source.id,
        packageId: payload.packageId,
        packageSha256: sha256,
        status: "rejected",
        code: "package_conflict",
        messageCount: payload.messages.length,
        producedAt: new Date(payload.producedAt),
        receiptId: receipt.receiptId,
        processedAt: new Date(),
      },
    });
    return { id: conflict.id, status: conflict.status, code: conflict.code };
  }

  const ledger = same || await prisma.weComHandoffPackage.create({
    data: {
      sourceId: payload.source.id,
      packageId: payload.packageId,
      packageSha256: sha256,
      status: "discovered",
      messageCount: payload.messages.length,
      producedAt: new Date(payload.producedAt),
    },
  });

  if (!payload.classification.worthProcessing) {
    const receipt = await writeWccHandoffReceipt(
      payload.source.id, payload.packageId, sha256, "accepted", "no_value",
    );
    const updated = await prisma.weComHandoffPackage.update({
      where: { id: ledger.id },
      data: {
        status: "no_value",
        outcome: "no_value",
        receiptId: receipt.receiptId,
        processedAt: new Date(),
        lastAttemptAt: new Date(),
      },
    });
    return { id: updated.id, status: updated.status, outcome: updated.outcome };
  }

  let matchedStudentId = selectedStudentId;
  if (!matchedStudentId) {
    const students = await prisma.student.findMany({
      select: { id: true, name: true, studentId: true, classId: true },
    });
    const matches = exactTitleMatches(payload.conversation.title, students);
    if (matches.length === 1) matchedStudentId = matches[0].id;
  }
  if (!matchedStudentId) {
    const receipt = await writeWccHandoffReceipt(
      payload.source.id, payload.packageId, sha256, "accepted", "pending_review",
    );
    const pending = await prisma.weComHandoffPackage.update({
      where: { id: ledger.id },
      data: {
        status: "pending_alignment",
        outcome: "pending_review",
        receiptId: receipt.receiptId,
        lastAttemptAt: new Date(),
      },
    });
    return { id: pending.id, status: pending.status, outcome: pending.outcome };
  }

  await prisma.weComHandoffPackage.update({
    where: { id: ledger.id },
    data: { status: "processing", selectedStudentId: matchedStudentId, lastAttemptAt: new Date() },
  });
  try {
    const result = await consumeWccHandoffPackage(prisma, payload, matchedStudentId);
    const outcome = result.status === "pending_review" ? "pending_review" : "no_value";
    let receiptId: string | null = null;
    try {
      const receipt = await writeWccHandoffReceipt(
        payload.source.id, payload.packageId, sha256, "accepted", outcome,
      );
      receiptId = receipt.receiptId;
    } catch {
      // 回执落盘失败不阻塞状态更新；DB 仍能反映最终结果。
    }
    const updated = await prisma.weComHandoffPackage.update({
      where: { id: ledger.id },
      data: {
        status: outcome,
        outcome,
        ...(receiptId ? { receiptId } : {}),
        processedAt: new Date(),
        code: null,
      },
    });
    return { id: updated.id, status: updated.status, outcome, draftCount: result.drafts.length };
  } catch (error) {
    const failure = safeFailure(error);
    let receiptId: string | null = null;
    try {
      const receipt = await writeWccHandoffReceipt(
        payload.source.id,
        payload.packageId,
        sha256,
        failure.status,
        undefined,
        failure.code,
      );
      receiptId = receipt.receiptId;
    } catch {
      // 同上，回执落盘失败不阻塞状态更新。
    }
    const updated = await prisma.weComHandoffPackage.update({
      where: { id: ledger.id },
      data: {
        status: failure.status,
        code: failure.code,
        ...(receiptId ? { receiptId } : {}),
        processedAt: new Date(),
      },
    });
    return { id: updated.id, status: updated.status, code: updated.code };
  }
}

async function performScanAndConsume(prisma: PrismaClient, limit = 20) {
  // 取所有 marker，按 DB 已有记录的 marker 排在后面，再截前 `limit`。
  // 这样能跳过已处理过的前 N 个，把新包送进处理路径。
  const allMarkers = await markerFiles();
  const seen = await prisma.weComHandoffPackage.findMany({
    select: { sourceId: true, packageId: true, packageSha256: true },
  });
  const seenKeys = new Set(seen.map((row) => `${row.sourceId}/${row.packageId}/${row.packageSha256}`));
  const ordered = [
    ...allMarkers.filter((marker) => {
      const packageId = path.basename(marker, ".sha256");
      const sourceId = path.basename(path.dirname(marker));
      // marker 的 sha256 需要读文件才知道，先用 (sourceId, packageId) 粗筛
      return !Array.from(seenKeys).some((key) => key.startsWith(`${sourceId}/${packageId}/`));
    }),
    ...allMarkers.filter((marker) => {
      const packageId = path.basename(marker, ".sha256");
      const sourceId = path.basename(path.dirname(marker));
      return Array.from(seenKeys).some((key) => key.startsWith(`${sourceId}/${packageId}/`));
    }),
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
      let receipt: StudentTrackReceiptV1 | null = null;
      if (!existing) {
        receipt = await writeWccHandoffReceipt(
          sourceId,
          packageId,
          digest,
          "rejected",
          undefined,
          failure.code,
        );
        await prisma.weComHandoffPackage.create({
          data: {
            sourceId,
            packageId,
            packageSha256: digest,
            status: "rejected",
            code: failure.code,
            messageCount: 0,
            producedAt: new Date(),
            processedAt: new Date(),
            receiptId: receipt.receiptId,
          },
        });
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
      orderBy: { name: "asc" },
      select: { id: true, name: true, studentId: true },
    }),
  ]);
  return {
    items: items.map((item) => ({
      id: item.id,
      packageId: item.packageId,
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
    const receipt = await writeWccHandoffReceipt(
      loaded.payload.source.id,
      loaded.payload.packageId,
      loaded.sha256,
      "accepted",
      "no_value",
    );
    return prisma.weComHandoffPackage.update({
      where: { id },
      data: {
        status: "discarded",
        outcome: "no_value",
        code: null,
        receiptId: receipt.receiptId,
        processedAt: new Date(),
        lastAttemptAt: new Date(),
      },
    });
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
