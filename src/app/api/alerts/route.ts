import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const DIM_LABEL: Record<string, string> = {
  A: "学习&测验",
  B: "精神&纪律",
  C: "课后任务",
  D: "考勤",
};

export async function GET() {
  try {
    const students = await prisma.student.findMany({
      include: { class: { select: { name: true } } },
    });
    if (students.length === 0) {
      return NextResponse.json({
        classOverview: [],
        classAlerts: [],
        studentAlerts: [],
        totalStudents: 0,
        redCount: 0,
        yellowCount: 0,
      });
    }

    // ── N+1 优化：批量查询 metrics，应用层按 student 分组取 top 3 ──
    const allIds = students.map((s) => s.id);
    const allMetrics = await prisma.sessionMetric.findMany({
      where: { studentId: { in: allIds } },
      orderBy: { createdAt: "desc" },
    });

    const metricsByStudent = new Map<string, typeof allMetrics>();
    for (const m of allMetrics) {
      const arr = metricsByStudent.get(m.studentId) || [];
      if (arr.length < 3) arr.push(m);
      metricsByStudent.set(m.studentId, arr);
    }

    // ── 考勤统计：查当前学期所有考勤记录 ──
    const today = new Date().toISOString().split("T")[0];
    const currentSemester = await prisma.semester.findFirst({
      where: { startDate: { lte: today }, endDate: { gte: today } },
      include: { sessions: { select: { id: true } } },
    });
    const sessionIds = currentSemester?.sessions.map((s) => s.id) ?? [];
    const totalSessions = sessionIds.length;

    const absenceMap = new Map<string, number>(); // studentId → absence count
    if (totalSessions > 0) {
      const attendances = await prisma.attendance.findMany({
        where: { sessionId: { in: sessionIds } },
        select: { studentId: true, present: true },
      });
      for (const a of attendances) {
        if (!a.present) {
          absenceMap.set(a.studentId, (absenceMap.get(a.studentId) ?? 0) + 1);
        }
      }
    }

    // ── 按班级分组 ──
    const classStudents = new Map<string, typeof students>();
    for (const s of students) {
      const clsName = s.class.name ?? s.class.code;
      const arr = classStudents.get(clsName) || [];
      arr.push(s);
      classStudents.set(clsName, arr);
    }

    // ── 班级概览 + 班级预警 ──
    const classOverview: {
      name: string;
      avgA: number;
      avgB: number;
      avgC: number;
      avgD: number;
      studentCount: number;
    }[] = [];

    const classAlerts: {
      className: string;
      dimension: string;
      avgScore: number;
      severity: "red" | "yellow";
    }[] = [];

    for (const [className, stuList] of classStudents) {
      let totalA = 0, totalB = 0, totalC = 0, totalD = 0;
      let count = 0;

      for (const s of stuList) {
        const latest = metricsByStudent.get(s.id)?.[0];
        if (!latest) continue;
        totalA += latest.scoreA;
        totalB += latest.scoreB;
        totalC += latest.scoreC;
        // D: 系统计算，不参与均分统计
        count++;
      }

      if (count === 0) {
        classOverview.push({ name: className, avgA: 0, avgB: 0, avgC: 0, avgD: 0, studentCount: stuList.length });
        continue;
      }

      const avgA = +(totalA / count).toFixed(1);
      const avgB = +(totalB / count).toFixed(1);
      const avgC = +(totalC / count).toFixed(1);

      classOverview.push({ name: className, avgA, avgB, avgC, avgD: 0, studentCount: stuList.length });

      // 班级预警：仅 ≥5 人班级触发
      if (stuList.length >= 5) {
        for (const dim of ["A", "B", "C"] as const) {
          const avg = dim === "A" ? avgA : dim === "B" ? avgB : avgC;
          if (avg < 2.5) {
            classAlerts.push({ className, dimension: DIM_LABEL[dim], avgScore: avg, severity: "red" });
          } else if (avg < 3.0) {
            classAlerts.push({ className, dimension: DIM_LABEL[dim], avgScore: avg, severity: "yellow" });
          }
        }
      }
    }

    // ── 学生预警：A/B/C 相对排名 ──
    const studentAlerts: {
      studentId: string;
      studentName: string;
      class: string;
      dimension: string;
      score: number;
      classAvg: number;
      deviation: number;
      severity: "red" | "yellow";
    }[] = [];

    for (const [className, stuList] of classStudents) {
      if (stuList.length < 3) continue; // 至少 3 人才有意义

      // 计算本班 A/B/C 均分
      const clsOverview = classOverview.find((c) => c.name === className);
      if (!clsOverview || clsOverview.avgA === 0) continue;
      const avgs = { A: clsOverview.avgA, B: clsOverview.avgB, C: clsOverview.avgC };

      for (const dim of ["A", "B", "C"] as const) {
        const avg = avgs[dim];
        // 收集低于均分的学生
        const below: { student: typeof students[0]; score: number; deviation: number }[] = [];

        for (const s of stuList) {
          const latest = metricsByStudent.get(s.id)?.[0];
          if (!latest) continue;
          const score = dim === "A" ? latest.scoreA : dim === "B" ? latest.scoreB : latest.scoreC;
          const dev = score - avg;
          if (dev < 0) {
            below.push({ student: s, score, deviation: +(dev.toFixed(1)) });
          }
        }

        if (below.length === 0) continue;

        // 按 deviation 升序（越负越靠前）
        below.sort((a, b) => a.deviation - b.deviation);

        const totalBelow = below.length;
        const redCutoff = Math.max(1, Math.ceil(totalBelow * 0.1));
        const yellowCutoff = Math.max(redCutoff + 1, Math.ceil(totalBelow * 0.2));

        // 处理并列：如果 cutoff 位置后有同分者，一并纳入
        const getEffectiveCut = (baseCut: number): number => {
          if (baseCut >= totalBelow) return totalBelow;
          const cutoffDev = below[baseCut - 1].deviation;
          let i = baseCut;
          while (i < totalBelow && below[i].deviation === cutoffDev) i++;
          return i;
        };

        const redEnd = getEffectiveCut(redCutoff);
        const yellowEnd = getEffectiveCut(yellowCutoff);

        for (let i = 0; i < redEnd; i++) {
          const { student, score, deviation } = below[i];
          studentAlerts.push({
            studentId: student.id,
            studentName: student.name,
            class: student.class.name ?? student.class.code,
            dimension: DIM_LABEL[dim],
            score,
            classAvg: avg,
            deviation,
            severity: "red",
          });
        }
        for (let i = redEnd; i < yellowEnd; i++) {
          const { student, score, deviation } = below[i];
          studentAlerts.push({
            studentId: student.id,
            studentName: student.name,
            class: student.class.name ?? student.class.code,
            dimension: DIM_LABEL[dim],
            score,
            classAvg: avg,
            deviation,
            severity: "yellow",
          });
        }
      }
    }

    // ── 学生预警：D 维度 考勤独立 ──
    if (totalSessions > 0) {
      for (const s of students) {
        const absences = absenceMap.get(s.id) ?? 0;
        if (absences >= 4) {
          studentAlerts.push({
            studentId: s.id,
            studentName: s.name,
            class: s.class.name ?? s.class.code,
            dimension: DIM_LABEL.D,
            score: absences,
            classAvg: totalSessions,
            deviation: 0,
            severity: "red",
          });
        } else if (absences >= 2) {
          studentAlerts.push({
            studentId: s.id,
            studentName: s.name,
            class: s.class.name ?? s.class.code,
            dimension: DIM_LABEL.D,
            score: absences,
            classAvg: totalSessions,
            deviation: 0,
            severity: "yellow",
          });
        }
      }
    }

    // 去重：同学生同维度只保留最严重的一条
    const deduped = new Map<string, typeof studentAlerts[0]>();
    for (const a of studentAlerts) {
      const key = `${a.studentId}|${a.dimension}`;
      const existing = deduped.get(key);
      if (!existing || (a.severity === "red" && existing.severity === "yellow")) {
        deduped.set(key, a);
      }
    }

    const finalStudentAlerts = [...deduped.values()];
    const redCount = finalStudentAlerts.filter((a) => a.severity === "red").length;
    const yellowCount = finalStudentAlerts.filter((a) => a.severity === "yellow").length;

    return NextResponse.json({
      classOverview,
      classAlerts,
      studentAlerts: finalStudentAlerts,
      totalStudents: students.length,
      redCount,
      yellowCount,
    });
  } catch (error) {
    console.error("GET /api/alerts error:", error);
    return NextResponse.json({ error: "获取数据失败" }, { status: 500 });
  }
}
