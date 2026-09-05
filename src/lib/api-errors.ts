export const API_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "conflict",
  "scope_in_recycle_bin",
  "repeat_export",
  "llm_service_error",
  "llm_schema_invalid",
  "stream_protocol_error",
  "cancelled",
  "forbidden_origin",
  "feature_unavailable",
  "legacy_generation_retired",
  "internal_error",
] as const;

export type ApiErrorCode = typeof API_ERROR_CODES[number];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value);
}

export class ApiError extends Error {
  readonly diagnosticId?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    readonly status: number,
    readonly code: ApiErrorCode = "internal_error",
    readonly retryable: boolean = false,
    details?: unknown,
    diagnosticId?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.details = details;
    this.diagnosticId = diagnosticId ?? (status >= 500 ? createDiagnosticId() : undefined);
  }
}

function createDiagnosticId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function safeApiError(error: unknown, fallback = "请求失败") {
  if (error instanceof ApiError) return error;
  return new ApiError(fallback, 500, "internal_error", false);
}

export function apiErrorBody(error: ApiError) {
  return {
    error: error.message,
    code: error.code,
    retryable: error.retryable,
    ...(error.status < 500 && error.details !== undefined ? { details: error.details } : {}),
    ...(error.diagnosticId ? { diagnosticId: error.diagnosticId } : {}),
  };
}

export function apiStreamErrorBody(error: ApiError) {
  return {
    message: error.message,
    code: error.code,
    retryable: error.retryable,
    ...(error.diagnosticId ? { diagnosticId: error.diagnosticId } : {}),
  };
}
