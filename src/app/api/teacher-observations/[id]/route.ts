import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { ObservationStatusSchema } from "@/lib/contracts/teaching-summary";
import { updateTeacherObservationStatus } from "@/services/teacher-observation-service";

const BodySchema = z.object({ status: ObservationStatusSchema }).strict();

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { status } = BodySchema.parse(await request.json().catch(() => null));
    const observation = await updateTeacherObservationStatus(id, status);
    if (!observation) return NextResponse.json({ error: "观察不存在" }, { status: 404 });
    return NextResponse.json(observation);
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "观察状态无效" }, { status: 400 });
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
    if (error instanceof Error && error.message === "observation_not_found") {
      return NextResponse.json({ error: "观察不存在" }, { status: 404 });
    }
    console.error("[/api/teacher-observations/[id]] error:", error);
    return NextResponse.json({ error: "更新观察状态失败" }, { status: 500 });
  }
}
