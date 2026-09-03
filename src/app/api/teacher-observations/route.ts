import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { ObservationStatusSchema } from "@/lib/contracts/teaching-summary";
import { listTeacherObservations } from "@/services/teacher-observation-service";

export async function GET(request: NextRequest) {
  try {
    const params = new URL(request.url).searchParams;
    const parsedStatuses = params.get("status")
      ?.split(",")
      .filter(Boolean)
      .map((status) => ObservationStatusSchema.safeParse(status))
      ?? [];
    if (parsedStatuses.some((status) => !status.success)) {
      return NextResponse.json({ error: "观察状态无效" }, { status: 400 });
    }
    return NextResponse.json(await listTeacherObservations({
      semesterId: params.get("semesterId") || undefined,
      classId: params.get("classId") || undefined,
      statuses: parsedStatuses.flatMap((status) => status.success ? [status.data] : []),
      limit: Number(params.get("limit") || 50),
    }));
  } catch (error) {
    const safe = safeApiError(error, "读取教师观察失败");
    return NextResponse.json(apiErrorBody(safe), { status: safe.status });
  }
}
