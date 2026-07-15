import { NextRequest, NextResponse } from "next/server";
import { getAlertDashboard } from "@/services/alert-service";
import { ServiceError } from "@/services/service-error";

export async function GET(request: NextRequest) {
  try {
    const semesterId = new URL(request.url).searchParams.get("semesterId") ?? undefined;
    return NextResponse.json(await getAlertDashboard({ semesterId }));
  } catch (error) {
    console.error("[/api/alerts] error:", error);
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "获取数据失败" }, { status: 500 });
  }
}
