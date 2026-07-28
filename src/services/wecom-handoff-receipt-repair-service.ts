import type { PrismaClient } from "@/generated/prisma/client";
import {
  SAFE_RECEIPT_CODES,
  type StudentTrackReceiptV1,
} from "@/lib/contracts/wecom-file-transfer";
import {
  listWccHandoffReceipts,
  readWccHandoffPackage,
  writeWccHandoffReceipt,
} from "@/services/wecom-file-handoff-service";
import {
  createDatabaseBackup,
  verifyDatabaseBackup,
} from "@/services/database-backup-service";

const TERMINAL_STATUS = new Set([
  "no_value",
  "discarded",
  "pending_review",
  "pending_alignment",
  "rejected",
  "retryable_failure",
]);
const SAFE_CODE = new Set<string>(SAFE_RECEIPT_CODES);
const REPAIR_CONFIRMATION = "REPAIR_HANDOFF_RECEIPTS";

type ExpectedReceipt = Pick<StudentTrackReceiptV1, "status"> & {
  outcome?: StudentTrackReceiptV1["outcome"];
  code?: StudentTrackReceiptV1["code"];
};

type LedgerItem = {
  id: string;
  sourceId: string;
  packageId: string;
  packageSha256: string;
  status: string;
  outcome: string | null;
  code: string | null;
  receiptId: string | null;
};

type SkipReason =
  | "missing_package"
  | "invalid_package"
  | "hash_conflict"
  | "non_terminal"
  | "unsupported_status";

type Inspection =
  | { action: "link_existing"; receipt: StudentTrackReceiptV1; expected: ExpectedReceipt }
  | { action: "create_receipt"; expected: ExpectedReceipt }
  | {
    action: "skip";
    reason: SkipReason;
  };

function expectedReceipt(item: LedgerItem): ExpectedReceipt | null {
  if (item.status === "no_value" || item.status === "discarded") {
    return { status: "accepted", outcome: "no_value" };
  }
  if (item.status === "pending_review" || item.status === "pending_alignment") {
    return { status: "accepted", outcome: "pending_review" };
  }
  if (item.status === "rejected" || item.status === "retryable_failure") {
    const code = SAFE_CODE.has(item.code || "")
      ? item.code as StudentTrackReceiptV1["code"]
      : "internal_error";
    return {
      status: item.status === "rejected" ? "rejected" : "retryable_failure",
      code,
    };
  }
  return null;
}

function receiptMatches(
  receipt: StudentTrackReceiptV1,
  item: LedgerItem,
  expected: ExpectedReceipt,
) {
  return receipt.packageId === item.packageId
    && receipt.packageSha256 === item.packageSha256
    && receipt.status === expected.status
    && receipt.outcome === expected.outcome
    && receipt.code === expected.code;
}

function fileFailureReason(error: unknown): SkipReason {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "missing_package";
  const message = error instanceof Error ? error.message : "";
  if (message === "hash_mismatch" || message === "package_conflict") return "hash_conflict";
  return "invalid_package";
}

async function inspectItem(item: LedgerItem): Promise<Inspection> {
  if (!TERMINAL_STATUS.has(item.status)) return { action: "skip", reason: "non_terminal" };
  const expected = expectedReceipt(item);
  if (!expected) return { action: "skip", reason: "unsupported_status" };

  try {
    const loaded = await readWccHandoffPackage(item.sourceId, item.packageId);
    if (loaded.sha256 !== item.packageSha256) return { action: "skip", reason: "hash_conflict" };
  } catch (error) {
    return { action: "skip", reason: fileFailureReason(error) };
  }

  const receipts = await listWccHandoffReceipts(item.sourceId, item.packageId);
  const existing = receipts
    .filter((receipt) => receiptMatches(receipt, item, expected))
    .sort((left, right) => right.processedAt.localeCompare(left.processedAt))[0];
  return existing
    ? { action: "link_existing", receipt: existing, expected }
    : { action: "create_receipt", expected };
}

function emptyReport(alreadyLinked: number) {
  return {
    alreadyLinked,
    missingReceiptId: 0,
    eligible: 0,
    linkExisting: 0,
    createReceipt: 0,
    skipped: {
      missingPackage: 0,
      invalidPackage: 0,
      hashConflict: 0,
      nonTerminal: 0,
      unsupportedStatus: 0,
    },
  };
}

function incrementSkip(report: ReturnType<typeof emptyReport>, reason: SkipReason) {
  const key = {
    missing_package: "missingPackage",
    invalid_package: "invalidPackage",
    hash_conflict: "hashConflict",
    non_terminal: "nonTerminal",
    unsupported_status: "unsupportedStatus",
  }[reason] as keyof typeof report.skipped;
  report.skipped[key] += 1;
}

async function missingLedgerItems(prisma: PrismaClient) {
  return prisma.weComHandoffPackage.findMany({
    where: { receiptId: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      sourceId: true,
      packageId: true,
      packageSha256: true,
      status: true,
      outcome: true,
      code: true,
      receiptId: true,
    },
  });
}

export async function previewWccHandoffReceiptRepair(prisma: PrismaClient) {
  const [items, alreadyLinked] = await Promise.all([
    missingLedgerItems(prisma),
    prisma.weComHandoffPackage.count({ where: { receiptId: { not: null } } }),
  ]);
  const report = emptyReport(alreadyLinked);
  report.missingReceiptId = items.length;
  for (const item of items) {
    const inspection = await inspectItem(item);
    if (inspection.action === "link_existing") {
      report.eligible += 1;
      report.linkExisting += 1;
    } else if (inspection.action === "create_receipt") {
      report.eligible += 1;
      report.createReceipt += 1;
    } else {
      incrementSkip(report, inspection.reason);
    }
  }
  return report;
}

export async function repairWccHandoffReceipts(
  prisma: PrismaClient,
  confirmation: string,
) {
  if (confirmation !== REPAIR_CONFIRMATION) throw new Error("confirmation_required");
  const before = await previewWccHandoffReceiptRepair(prisma);
  if (!before.eligible) {
    return { preview: before, linkedExisting: 0, createdReceipts: 0, skippedAfterBackup: 0 };
  }

  const backup = await createDatabaseBackup({ prefix: "pre-handoff-receipt-repair" });
  await verifyDatabaseBackup(backup.backupPath);

  let linkedExisting = 0;
  let createdReceipts = 0;
  let skippedAfterBackup = 0;
  for (const item of await missingLedgerItems(prisma)) {
    const inspection = await inspectItem(item);
    if (inspection.action === "skip") {
      skippedAfterBackup += 1;
      continue;
    }
    const receipt = inspection.action === "link_existing"
      ? inspection.receipt
      : await writeWccHandoffReceipt(
        item.sourceId,
        item.packageId,
        item.packageSha256,
        inspection.expected.status,
        inspection.expected.outcome,
        inspection.expected.code,
      );
    const updated = await prisma.weComHandoffPackage.updateMany({
      where: { id: item.id, receiptId: null },
      data: { receiptId: receipt.receiptId },
    });
    if (!updated.count) {
      skippedAfterBackup += 1;
      continue;
    }
    if (inspection.action === "link_existing") linkedExisting += 1;
    else createdReceipts += 1;
  }

  return {
    preview: before,
    linkedExisting,
    createdReceipts,
    skippedAfterBackup,
    backup: {
      createdAt: backup.manifest.createdAt,
      sha256: backup.manifest.sha256,
      sizeBytes: backup.manifest.sizeBytes,
      integrity: backup.manifest.verification.integrity,
    },
  };
}
