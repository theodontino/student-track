import { NextResponse } from "next/server";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";
import { clearSessionFacts, getSessionFactsImpact } from "@/services/session-facts-service";

function failure(error: unknown, operation: string) {
  const fallback = `${operation}课次事实失败`;
  if (error instanceof ApiError) {
    const failure = safeApiError(error, fallback);
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
  console.error(`${operation} /api/sessions/[id]/facts`, error);
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await getSessionFactsImpact(id));
  } catch (error) {
    return failure(error, "读取");
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await clearSessionFacts(id));
  } catch (error) {
    return failure(error, "清空");
  }
}
