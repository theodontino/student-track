import { recordDiagnosticFailure } from "@/lib/diagnostics";
import { ApiError } from "@/lib/api-error-core";
import type { DiagnosticFailureEvent } from "@/lib/contracts/diagnostics";

export { API_ERROR_CODES, ApiError, isApiErrorCode, type ApiErrorCode } from "@/lib/api-error-core";

export function safeApiError(
  error: unknown,
  fallback = "请求失败",
  source: DiagnosticFailureEvent["source"] = "api.safe_error",
) {
  const failure = error instanceof ApiError ? error : new ApiError(fallback, 500, "internal_error", false);
  if (failure.status >= 500) {
    void recordDiagnosticFailure({
      diagnosticId: failure.diagnosticId!,
      source,
      status: failure.status,
      code: failure.code,
      retryable: failure.retryable,
    });
  }
  return failure;
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
