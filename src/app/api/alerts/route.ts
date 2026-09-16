import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { getAlertDashboard } from "@/services/alert-service";
import { ServiceError } from "@/services/service-error";

export async function GET(request: NextRequest) {
  try {
    const semesterId = new URL(request.url).searchParams.get("semesterId") ?? undefined;
    return NextResponse.json(await getAlertDashboard({ semesterId }));
  } catch (error) {
    console.error("[/api/alerts] error:", error);
    if (error instanceof ServiceError && error.status < 500) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const failure = safeApiError(error, "获取数据失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
