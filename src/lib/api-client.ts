export { ApiError } from "@/lib/api-errors";
import { ApiError as UnifiedApiError, type ApiErrorCode } from "@/lib/api-errors";
import type { z } from "zod";

async function readError(response: Response): Promise<{ message: string; details?: unknown }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body: unknown = await response.json().catch(() => null);
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      const message = [record.error, record.message].find((value): value is string => typeof value === "string");
      return { message: message ?? `请求失败（${response.status}）`, details: body };
    }
  }
  const text = await response.text().catch(() => "");
  return { message: text.trim() || `请求失败（${response.status}）` };
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const error = await readError(response);
    const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
    const code = typeof details.code === "string" ? details.code as ApiErrorCode : "internal_error";
    throw new UnifiedApiError(error.message, response.status,
      code,
      typeof details.retryable === "boolean" ? details.retryable : false,
      error.details,
      typeof details.diagnosticId === "string" ? details.diagnosticId : undefined);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function requestJsonValidated<T>(
  schema: z.ZodType<T>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const value = await requestJson<unknown>(input, init);
  return schema.parse(value);
}

export async function downloadFile(input: RequestInfo | URL, filename: string, init?: RequestInit) {
  const response = await fetch(input, init);
  if (!response.ok) {
    const error = await readError(response);
    const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
    const code = typeof details.code === "string" ? details.code as ApiErrorCode : "internal_error";
    throw new UnifiedApiError(error.message, response.status,
      code,
      typeof details.retryable === "boolean" ? details.retryable : false,
      error.details,
      typeof details.diagnosticId === "string" ? details.diagnosticId : undefined);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
