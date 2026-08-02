export type ApiErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "repeat_export"
  | "llm_service_error"
  | "llm_schema_invalid"
  | "stream_protocol_error"
  | "cancelled"
  | "forbidden_origin"
  | "internal_error";

export class ApiError extends Error {
  readonly diagnosticId?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    readonly status: number,
    readonly code?: ApiErrorCode,
    readonly retryable?: boolean,
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
