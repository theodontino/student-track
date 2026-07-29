import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const STATUS_MAP = {
  active: "ACTIVE",
  inactive: "INACTIVE",
} as const;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json() as { status?: unknown };
    const requested = typeof body.status === "string"
      ? STATUS_MAP[body.status as keyof typeof STATUS_MAP]
      : undefined;
    if (!requested) {
      return NextResponse.json({ error: "状态必须是 active 或 inactive" }, { status: 400 });
    }
    const current = await prisma.student.findUnique({
      where: { id },
      select: { id: true, name: true, rosterStatus: true, statusEffectiveAt: true },
    });
    if (!current) return NextResponse.json({ error: "学生不存在" }, { status: 404 });
    if (current.rosterStatus === requested) {
      return NextResponse.json({
        id: current.id,
        rosterStatus: current.rosterStatus,
        statusEffectiveAt: current.statusEffectiveAt,
        changed: false,
      });
    }
    const effectiveAt = new Date();
    const transition = await prisma.$transaction(async (tx) => {
      const changed = await tx.student.updateMany({
        where: { id, rosterStatus: current.rosterStatus },
        data: { rosterStatus: requested, statusEffectiveAt: effectiveAt },
      });
      if (changed.count === 0) {
        const latest = await tx.student.findUniqueOrThrow({
          where: { id },
          select: { id: true, name: true, rosterStatus: true, statusEffectiveAt: true },
        });
        return { updated: latest, changed: false };
      }
      await tx.systemLog.create({
        data: {
          action: "student.roster-status.updated",
          targetType: "Student",
          targetId: current.id,
          targetName: current.name,
          detail: JSON.stringify({ before: current.rosterStatus, after: requested }),
        },
      });
      const updated = await tx.student.findUniqueOrThrow({
        where: { id },
        select: { id: true, name: true, rosterStatus: true, statusEffectiveAt: true },
      });
      return { updated, changed: true };
    });
    const { updated } = transition;
    return NextResponse.json({
      id: updated.id,
      rosterStatus: updated.rosterStatus,
      statusEffectiveAt: updated.statusEffectiveAt,
      changed: transition.changed,
    });
  } catch {
    return NextResponse.json({ error: "更新学生状态失败" }, { status: 500 });
  }
}
