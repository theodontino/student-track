export { ApiError } from "@/lib/api-errors";
import { ApiError as UnifiedApiError, isApiErrorCode } from "@/lib/api-errors";
import { ApiErrorResponseSchema, type ApiErrorResponse } from "@/lib/contracts/api";
import type { z } from "zod";

async function readError(response: Response): Promise<{
  message: string;
  details?: unknown;
  envelope?: ApiErrorResponse;
}> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body: unknown = await response.json().catch(() => null);
    if (body && typeof body === "object") {
      const envelope = ApiErrorResponseSchema.safeParse(body);
      const record = body as Record<string, unknown>;
      const message = [record.error, record.message].find((value): value is string => typeof value === "string");
      return {
        message: message ?? `请求失败（${response.status}）`,
        details: body,
        ...(envelope.success ? { envelope: envelope.data } : {}),
      };
    }
  }
  const text = await response.text().catch(() => "");
  return { message: text.trim() || `请求失败（${response.status}）` };
}

async function responseApiError(response: Response) {
  const error = await readError(response);
  const envelope = error.envelope;
  if (envelope && isApiErrorCode(envelope.code)) {
    return new UnifiedApiError(
      error.message,
      response.status,
      envelope.code,
      envelope.retryable,
      error.details,
      envelope.diagnosticId,
    );
  }
  return new UnifiedApiError(
    error.message,
    response.status,
    "internal_error",
    false,
    error.details,
    envelope?.diagnosticId,
  );
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw await responseApiError(response);
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
    throw await responseApiError(response);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
