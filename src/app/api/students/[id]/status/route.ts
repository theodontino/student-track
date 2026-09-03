import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertClassInSemester, requireSemesterId } from "@/services/student-enrollment-service";
import { ServiceError } from "@/services/service-error";

const STATUS_MAP = { active: "ACTIVE", inactive: "INACTIVE" } as const;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json() as { status?: unknown; semesterId?: unknown };
    const requested = typeof body.status === "string"
      ? STATUS_MAP[body.status as keyof typeof STATUS_MAP]
      : undefined;
    if (!requested) return NextResponse.json({ error: "状态必须是 active 或 inactive" }, { status: 400 });
    const semesterId = await requireSemesterId(prisma, typeof body.semesterId === "string" ? body.semesterId : undefined);
    const current = await prisma.studentClassEnrollment.findUnique({
      where: { studentId_semesterId: { studentId: id, semesterId } },
      include: { student: { select: { id: true, name: true } } },
    });
    if (!current) return NextResponse.json({ error: "学生在所选学期没有班级归属" }, { status: 404 });
    await assertClassInSemester(prisma, current.classId, semesterId);
    if (current.rosterStatus === requested) {
      return NextResponse.json({ id, semesterId, rosterStatus: current.rosterStatus, statusEffectiveAt: current.statusEffectiveAt, changed: false });
    }
    const effectiveAt = new Date();
    const transition = await prisma.$transaction(async (tx) => {
      const changed = await tx.studentClassEnrollment.updateMany({
        where: { studentId: id, semesterId, rosterStatus: current.rosterStatus },
        data: { rosterStatus: requested, statusEffectiveAt: effectiveAt },
      });
      if (changed.count === 0) {
        const latest = await tx.studentClassEnrollment.findUniqueOrThrow({ where: { studentId_semesterId: { studentId: id, semesterId } } });
        return { updated: latest, changed: false };
      }
      await tx.systemLog.create({
        data: {
          action: "student.roster-status.updated",
          targetType: "Student",
          targetId: id,
          targetName: current.student.name,
          detail: JSON.stringify({ semesterId, before: current.rosterStatus, after: requested }),
        },
      });
      const updated = await tx.studentClassEnrollment.findUniqueOrThrow({ where: { studentId_semesterId: { studentId: id, semesterId } } });
      return { updated, changed: true };
    });
    return NextResponse.json({
      id,
      semesterId,
      rosterStatus: transition.updated.rosterStatus,
      statusEffectiveAt: transition.updated.statusEffectiveAt,
      changed: transition.changed,
    });
  } catch (error) {
    console.error("PATCH /api/students/[id]/status", error);
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "更新学生状态失败" }, { status: 500 });
  }
}
