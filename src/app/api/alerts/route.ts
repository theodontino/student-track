import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    // Get all students
    const students = await prisma.student.findMany({
      include: {
        metrics: { orderBy: { date: "desc" }, take: 3 },
      },
    });

    // Class overview: calculate average scores per class
    const allMetrics = await prisma.dailyMetric.findMany({
      include: { student: { select: { class: true, name: true, id: true } } },
    });

    // Group by class
    const classMap: Record<string, { totalA: number; totalB: number; totalC: number; totalD: number; count: number }> = {};
    for (const m of allMetrics) {
      const cls = m.student.class;
      if (!classMap[cls]) {
        classMap[cls] = { totalA: 0, totalB: 0, totalC: 0, totalD: 0, count: 0 };
      }
      classMap[cls].totalA += m.scoreA;
      classMap[cls].totalB += m.scoreB;
      classMap[cls].totalC += m.scoreC;
      classMap[cls].totalD += m.scoreD;
      classMap[cls].count += 1;
    }

    const classOverview = Object.entries(classMap).map(([name, data]) => ({
      name,
      avgA: +(data.totalA / data.count).toFixed(1),
      avgB: +(data.totalB / data.count).toFixed(1),
      avgC: +(data.totalC / data.count).toFixed(1),
      avgD: +(data.totalD / data.count).toFixed(1),
      studentCount: students.filter((s) => s.class === name).length,
    }));

    // Alert detection
    const alerts: {
      studentId: string;
      studentName: string;
      class: string;
      dimension: string;
      reason: string;
      severity: "red" | "yellow";
    }[] = [];

    for (const student of students) {
      const metrics = student.metrics;
      if (metrics.length === 0) continue;

      const latest = metrics[0];

      // Check single score < 2
      for (const dim of ["A", "B", "C", "D"] as const) {
        const dimName = dim === "A" ? "学习&测验" : dim === "B" ? "精神&纪律" : dim === "C" ? "课后任务" : "考勤";
        const score = dim === "A" ? latest.scoreA : dim === "B" ? latest.scoreB : dim === "C" ? latest.scoreC : latest.scoreD;
        if (score < 2) {
          alerts.push({
            studentId: student.id,
            studentName: student.name,
            class: student.class,
            dimension: dimName,
            reason: `${dimName}得分为 ${score} 分（低于2分）`,
            severity: "red",
          });
        }
      }

      // Check last 3 records all < 3
      if (metrics.length >= 2) {  // changed from 3 to 2 since we already checked latest
        // We need exactly 3 records to check
      }
      if (metrics.length >= 3) {
        for (const dim of ["A", "B", "C", "D"] as const) {
          const dimName = dim === "A" ? "学习&测验" : dim === "B" ? "精神&纪律" : dim === "C" ? "课后任务" : "考勤";
          const allLow = metrics.slice(0, 3).every((m) => {
            const score = dim === "A" ? m.scoreA : dim === "B" ? m.scoreB : dim === "C" ? m.scoreC : m.scoreD;
            return score < 3;
          });
          if (allLow) {
            // Avoid duplicate alerts for same student+dim
            if (!alerts.some((a) => a.studentId === student.id && a.dimension === dimName)) {
              alerts.push({
                studentId: student.id,
                studentName: student.name,
                class: student.class,
                dimension: dimName,
                reason: `连续3次记录 ${dimName} < 3分`,
                severity: "yellow",
              });
            }
          }
        }
      }
    }

    return NextResponse.json({
      classOverview,
      alerts,
      totalStudents: students.length,
      alertCount: alerts.length,
    });
  } catch (error) {
    console.error("GET /api/alerts error:", error);
    return NextResponse.json({ error: "获取数据失败" }, { status: 500 });
  }
}
