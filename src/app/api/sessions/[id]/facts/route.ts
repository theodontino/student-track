import { NextResponse } from "next/server";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { clearSessionFacts, getSessionFactsImpact } from "@/services/session-facts-service";

function failure(error: unknown, operation: string) {
  if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
  console.error(`${operation} /api/sessions/[id]/facts`, error);
  return NextResponse.json({ error: `${operation}课次事实失败` }, { status: 500 });
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
