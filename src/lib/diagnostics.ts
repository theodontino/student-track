import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import packageJson from "../../package.json";
import {
  DiagnosticFailureEventSchema,
  DiagnosticsExportV1Schema,
  type DiagnosticFailureEvent,
  type DiagnosticsExportV1,
} from "@/lib/contracts/diagnostics";
import {
  resolveStudentTrackArchiveRoot,
  resolveStudentTrackDataPath,
  resolveStudentTrackRuntimePath,
} from "@/lib/runtime-paths";
import { SYSTEM_CAPABILITIES } from "@/lib/contracts/system";
import { getProductEdition } from "@/lib/product-edition";
import { prisma } from "@/lib/prisma";

const EVENT_FILE = "diagnostics/failure-events.jsonl";
const MAX_EVENTS = 500;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let eventWriteQueue = Promise.resolve();

type DiagnosticFailureInput = Pick<DiagnosticFailureEvent, "diagnosticId" | "source" | "status" | "code" | "retryable">;
type DiagnosticsHealth = DiagnosticsExportV1["health"];

export interface DiagnosticsDependencies {
  now?: () => Date;
  databaseStatus?: () => Promise<DiagnosticsHealth["database"]>;
  migrationStatus?: () => Promise<DiagnosticsHealth["migrations"]>;
  runtimeDataStatus?: () => Promise<DiagnosticsHealth["runtimeData"]>;
}

function eventFilePath() {
  return resolveStudentTrackDataPath(EVENT_FILE, "STUDENT_TRACK_DIAGNOSTICS_PATH");
}

function recentEvents(raw: string, now = Date.now()) {
  return raw.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      return [];
    }
    const parsed = DiagnosticFailureEventSchema.safeParse(candidate);
    if (!parsed.success || now - new Date(parsed.data.occurredAt).getTime() > RETENTION_MS) return [];
    return [parsed.data];
  }).slice(-MAX_EVENTS);
}

async function readRecentEvents() {
  try {
    return recentEvents(await readFile(eventFilePath(), "utf8"));
  } catch {
    return [];
  }
}

async function databaseStatus(): Promise<DiagnosticsHealth["database"]> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "readable";
  } catch {
    return "unavailable";
  }
}

async function migrationStatus(): Promise<DiagnosticsHealth["migrations"]> {
  try {
    const migrations = await prisma.$queryRaw<Array<{ finished_at: Date | null; rolled_back_at: Date | null }>>`
      SELECT finished_at, rolled_back_at FROM "_prisma_migrations"
    `;
    return migrations.some((migration) => migration.finished_at === null || migration.rolled_back_at !== null)
      ? "incomplete"
      : "ready";
  } catch {
    return "unavailable";
  }
}

async function componentStatus(targetPath: string): Promise<DiagnosticsHealth["runtimeData"]["dataRoot"]> {
  try {
    await stat(targetPath);
    await access(targetPath, constants.R_OK | constants.W_OK);
    return { exists: true, access: "read_write" };
  } catch {
    try {
      await access(targetPath, constants.R_OK);
      return { exists: true, access: "read_only" };
    } catch {
      try {
        await stat(targetPath);
        return { exists: true, access: "unavailable" };
      } catch {
        return { exists: false, access: "unavailable" };
      }
    }
  }
}

async function ledgerStatus(): Promise<DiagnosticsHealth["runtimeData"]["diagnosticsLedger"]> {
  const filePath = eventFilePath();
  const current = await componentStatus(filePath);
  if (current.exists) return current;
  const directory = path.dirname(filePath);
  try {
    await access(directory, constants.R_OK | constants.W_OK);
    return { exists: false, access: "read_write" };
  } catch {
    try {
      await access(directory, constants.R_OK);
      return { exists: false, access: "read_only" };
    } catch {
      return current;
    }
  }
}

async function runtimeDataStatus(): Promise<DiagnosticsHealth["runtimeData"]> {
  const [dataRoot, diagnosticsLedger, feedbackAttachments, feedbackInbox, archives] = await Promise.all([
    componentStatus(resolveStudentTrackDataPath(".", "STUDENT_TRACK_DATA_ROOT")),
    ledgerStatus(),
    componentStatus(resolveStudentTrackRuntimePath(
      "feedback-attachments",
      "STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT",
      path.join(os.homedir(), "Library", "Application Support", "Student Track", "feedback-attachments"),
    )),
    componentStatus(resolveStudentTrackRuntimePath(
      "feedback-inbox",
      "STUDENT_TRACK_FEEDBACK_INBOX_ROOT",
      path.join(os.homedir(), "Library", "Application Support", "Student Track", "feedback-inbox"),
    )),
    componentStatus(resolveStudentTrackArchiveRoot()),
  ]);
  return { dataRoot, diagnosticsLedger, feedbackAttachments, feedbackInbox, archives };
}

/** Diagnostics are best-effort only: a failed write never changes a business result. */
export async function recordDiagnosticFailure(input: DiagnosticFailureInput) {
  eventWriteQueue = eventWriteQueue.then(async () => {
    try {
      const event = DiagnosticFailureEventSchema.parse({ schemaVersion: 1, occurredAt: new Date().toISOString(), ...input });
      const events = [...await readRecentEvents(), event].slice(-MAX_EVENTS);
      const filePath = eventFilePath();
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${events.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    } catch {
      // Diagnostics must never affect the request or other business work.
    }
  });
  await eventWriteQueue;
}

export async function createDiagnosticsExport(dependencies: DiagnosticsDependencies = {}): Promise<DiagnosticsExportV1> {
  const now = dependencies.now?.() ?? new Date();
  await eventWriteQueue;
  const [database, migrations, runtimeData] = await Promise.all([
    (dependencies.databaseStatus ?? databaseStatus)(),
    (dependencies.migrationStatus ?? migrationStatus)(),
    (dependencies.runtimeDataStatus ?? runtimeDataStatus)(),
  ]);
  return DiagnosticsExportV1Schema.parse({
    format: "student-track.diagnostics.v1",
    exportedAt: now.toISOString(),
    product: "student-track",
    appVersion: packageJson.version,
    edition: getProductEdition(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version,
    systemCapabilities: [...SYSTEM_CAPABILITIES].sort(),
    health: { database, migrations, runtimeData },
    events: await readRecentEvents(),
  });
}
