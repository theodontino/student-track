import { NextRequest, NextResponse } from "next/server";
import { logStudentEnrollmentTransfer } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { ServiceError } from "@/services/service-error";
import { requireSemesterId, transferStudentEnrollment } from "@/services/student-enrollment-service";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json() as { semesterId?: unknown; classId?: unknown };
    if (typeof body.semesterId !== "string" || !body.semesterId.trim()) {
      return NextResponse.json({ error: "semesterId 为必填项" }, { status: 400 });
    }
    if (typeof body.classId !== "string" || !body.classId.trim()) {
      return NextResponse.json({ error: "classId 为必填项" }, { status: 400 });
    }
    const semesterId = await requireSemesterId(prisma, body.semesterId.trim());
    const classId = body.classId.trim();
    const result = await prisma.$transaction(async (tx) => {
      const transition = await transferStudentEnrollment(tx, {
        studentId: id,
        semesterId,
        classId,
      });
      const student = await tx.student.findUniqueOrThrow({ where: { id }, select: { name: true } });
      return { transition, student };
    });

    if (result.transition.changed && result.transition.previousClass) {
      await logStudentEnrollmentTransfer({
        studentId: id,
        studentName: result.student.name,
        semesterId,
        previousClass: result.transition.previousClass,
        currentClass: result.transition.enrollment.class,
      });
    }

    return NextResponse.json({
      id,
      semesterId,
      changed: result.transition.changed,
      previousClass: result.transition.previousClass,
      currentClass: result.transition.enrollment.class,
      class: result.transition.enrollment.class,
      rosterStatus: result.transition.enrollment.rosterStatus,
      statusEffectiveAt: result.transition.enrollment.statusEffectiveAt,
    });
  } catch (error) {
    console.error("PATCH /api/students/[id]/enrollment", error);
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "转班失败" }, { status: 500 });
  }
}
