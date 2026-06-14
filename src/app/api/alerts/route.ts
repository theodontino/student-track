import { NextResponse } from "next/server";
import { getAlertDashboard } from "@/services/alert-service";

export async function GET() {
  try {
    return NextResponse.json(await getAlertDashboard());
  } catch (error) {
    console.error("[/api/alerts] error:", error);
    return NextResponse.json({ error: "获取数据失败" }, { status: 500 });
  }
}
