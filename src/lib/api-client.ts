export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

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
    throw new ApiError(error.message, response.status, error.details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function downloadFile(input: RequestInfo | URL, filename: string, init?: RequestInit) {
  const response = await fetch(input, init);
  if (!response.ok) {
    const error = await readError(response);
    throw new ApiError(error.message, response.status, error.details);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
