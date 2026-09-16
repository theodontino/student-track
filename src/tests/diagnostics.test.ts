import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/system/diagnostics/export/route";
import { DIAGNOSTICS_EXPORT_FORMAT, DiagnosticsExportV1Schema } from "@/lib/contracts/diagnostics";
import { createDiagnosticsExport, recordDiagnosticFailure } from "@/lib/diagnostics";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-error-core";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";

describe.sequential("privacy-safe diagnostics export", () => {
  let root = "";
  let eventPath = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "student-track-diagnostics-"));
    eventPath = path.join(root, "failure-events.jsonl");
    vi.stubEnv("STUDENT_TRACK_DIAGNOSTICS_PATH", eventPath);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("validates the versioned contract and downloads an in-memory JSON attachment", async () => {
    const logsBefore = await prisma.systemLog.count();
    await recordDiagnosticFailure({ diagnosticId: "diag-synthetic-1", source: "api.students", status: 500, code: "internal_error", retryable: false });

    const response = await GET();
    const text = await response.text();
    const payload = DiagnosticsExportV1Schema.parse(JSON.parse(text));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="student-track-diagnostics-\d{8}T\d{6}Z\.json"$/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.format).toBe(DIAGNOSTICS_EXPORT_FORMAT);
    expect(payload.health).toMatchObject({ database: "readable", migrations: "ready", runtimeData: { diagnosticsLedger: { exists: true, access: "read_write" } } });
    expect(payload.events).toEqual([expect.objectContaining({ source: "api.students", status: 500, code: "internal_error" })]);
    expect(await readdir(root)).toEqual(["failure-events.jsonl"]);
    expect(await prisma.systemLog.count()).toBe(logsBefore);
  });

  it("keeps only recent whitelisted events and never includes prohibited values", async () => {
    await writeFile(eventPath, [
      JSON.stringify({ schemaVersion: 1, occurredAt: "2000-01-01T00:00:00.000Z", diagnosticId: "diag-old", source: "api.export", status: 500, code: "internal_error", retryable: false }),
      JSON.stringify({ schemaVersion: 1, occurredAt: new Date().toISOString(), diagnosticId: "diag-contaminated", source: "api.export", status: 502, code: "internal_error", retryable: true, name: "Synthetic Student", path: "/private/source", stack: "stack", secret: "token" }),
      "not-json",
      JSON.stringify({ schemaVersion: 1, occurredAt: new Date().toISOString(), diagnosticId: "diag-clean", source: "api.export", status: 502, code: "internal_error", retryable: true }),
    ].join("\n"), "utf8");

    const payload = await createDiagnosticsExport();
    const raw = JSON.stringify(payload);

    expect(payload.events).toEqual([expect.objectContaining({ source: "api.export", status: 502, code: "internal_error", retryable: true })]);
    expect(raw).not.toContain("Synthetic Student");
    expect(raw).not.toContain("/private/source");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("stack");
  });

  it("trims the stored ledger to 500 events without writing an export copy", async () => {
    const now = new Date().toISOString();
    await writeFile(eventPath, Array.from({ length: 500 }, (_, index) => JSON.stringify({
      schemaVersion: 1, occurredAt: now, diagnosticId: `diag-${index}`, source: "api.safe_error", status: 500, code: `failure_${index}`, retryable: false,
    })).join("\n"), "utf8");

    await recordDiagnosticFailure({ diagnosticId: "diag-final", source: "api.safe_error", status: 500, code: "internal_error", retryable: true });

    const stored = (await readFile(eventPath, "utf8")).trim().split("\n");
    expect(stored).toHaveLength(500);
    expect(JSON.parse(stored.at(-1)!)).toMatchObject({ code: "internal_error" });
    expect(await readdir(root)).toEqual(["failure-events.jsonl"]);
  });

  it("serializes concurrent failure writes without dropping events", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => recordDiagnosticFailure({
      diagnosticId: `diag-concurrent-${index}`,
      source: "api.safe_error",
      status: 500,
      code: "internal_error",
      retryable: index % 2 === 0,
    })));
    const stored = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(stored).toHaveLength(20);
    expect(new Set(stored.map((event) => event.diagnosticId)).size).toBe(20);
  });

  it("reports a creatable ledger separately from an existing ledger file", async () => {
    const payload = await createDiagnosticsExport({
      databaseStatus: async () => "readable",
      migrationStatus: async () => "ready",
    });
    expect(payload.health.runtimeData.diagnosticsLedger).toEqual({ exists: false, access: "read_write" });
    expect(payload.events).toEqual([]);
  });

  it("reports safe health failures without exposing their causes", async () => {
    const payload = await createDiagnosticsExport({
      now: () => new Date("2026-09-16T12:34:56.000Z"),
      databaseStatus: async () => "unavailable",
      migrationStatus: async () => "incomplete",
      runtimeDataStatus: async () => ({
        dataRoot: { exists: false, access: "unavailable" },
        diagnosticsLedger: { exists: false, access: "unavailable" },
        feedbackAttachments: { exists: false, access: "unavailable" },
        feedbackInbox: { exists: false, access: "unavailable" },
        archives: { exists: false, access: "unavailable" },
      }),
    });
    const raw = JSON.stringify(payload);
    expect(payload.health).toMatchObject({ database: "unavailable", migrations: "incomplete", runtimeData: { diagnosticsLedger: { exists: false, access: "unavailable" } } });
    expect(raw).not.toContain(eventPath);
    expect(raw).not.toContain("DATABASE_URL");
    expect(raw).not.toContain("_prisma_migrations");
  });

  it("uses one diagnostic ID for a safe 5xx event and response envelope", async () => {
    const failure = safeApiError(new ApiError("synthetic failure", 500), "请求失败", "api.students");
    const body = apiErrorBody(failure);
    const exportedImmediately = await createDiagnosticsExport();
    expect(exportedImmediately.events).toContainEqual(expect.objectContaining({ diagnosticId: body.diagnosticId, source: "api.students", retryable: false }));
    expect(body).toMatchObject({ code: "internal_error", retryable: false, diagnosticId: failure.diagnosticId });
  });
});
