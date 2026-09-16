import { z } from "zod";
import { SYSTEM_CAPABILITIES } from "@/lib/contracts/system";

export const DIAGNOSTICS_EXPORT_FORMAT = "student-track.diagnostics.v1" as const;

export const DiagnosticFailureSourceSchema = z.enum([
  "api.safe_error",
  "api.students",
  "api.classes",
  "api.student_enrollment",
  "api.student_import",
  "api.export",
  "server.unhandled",
]);

export const DiagnosticFailureEventSchema = z.object({
  schemaVersion: z.literal(1),
  occurredAt: z.string().datetime(),
  diagnosticId: z.string().min(1).max(100),
  source: DiagnosticFailureSourceSchema,
  status: z.number().int().min(500).max(599),
  code: z.string().min(1).max(80),
  retryable: z.boolean(),
}).strict();

export const DiagnosticsRuntimeComponentSchema = z.object({
  exists: z.boolean(),
  access: z.enum(["read_write", "read_only", "unavailable"]),
}).strict();

export const DiagnosticsHealthSchema = z.object({
  database: z.enum(["readable", "unavailable"]),
  migrations: z.enum(["ready", "incomplete", "unavailable"]),
  runtimeData: z.object({
    dataRoot: DiagnosticsRuntimeComponentSchema,
    diagnosticsLedger: DiagnosticsRuntimeComponentSchema,
    feedbackAttachments: DiagnosticsRuntimeComponentSchema,
    feedbackInbox: DiagnosticsRuntimeComponentSchema,
    archives: DiagnosticsRuntimeComponentSchema,
  }).strict(),
}).strict();

export const DiagnosticsExportV1Schema = z.object({
  format: z.literal(DIAGNOSTICS_EXPORT_FORMAT),
  exportedAt: z.string().datetime(),
  product: z.literal("student-track"),
  appVersion: z.string().min(1).max(40),
  edition: z.enum(["core", "full"]),
  platform: z.enum(["darwin", "linux", "win32"]),
  arch: z.enum(["arm64", "x64"]),
  osRelease: z.string().min(1).max(80).regex(/^[0-9A-Za-z._-]+$/),
  nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
  systemCapabilities: z.array(z.enum(SYSTEM_CAPABILITIES)).max(SYSTEM_CAPABILITIES.length),
  health: DiagnosticsHealthSchema,
  events: z.array(DiagnosticFailureEventSchema).max(500),
}).strict();

export type DiagnosticFailureEvent = z.infer<typeof DiagnosticFailureEventSchema>;
export type DiagnosticsExportV1 = z.infer<typeof DiagnosticsExportV1Schema>;
