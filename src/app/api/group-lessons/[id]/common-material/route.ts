import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setGroupLessonCommonMaterial } from "@/services/common-material-service";
import { ServiceError } from "@/services/service-error";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as { lessonNumber?: unknown };
    const lessonNumber = body.lessonNumber === null ? null : Number(body.lessonNumber);
    if (lessonNumber !== null && (!Number.isInteger(lessonNumber) || lessonNumber < 1 || lessonNumber > 1000)) {
      return NextResponse.json({ error: "lessonNumber 必须是 1-1000 的整数或 null" }, { status: 400 });
    }
    return NextResponse.json(await setGroupLessonCommonMaterial(id, lessonNumber, prisma));
  } catch (error) {
    const status = error instanceof ServiceError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存共同课公共材料失败" }, { status });
  }
}
