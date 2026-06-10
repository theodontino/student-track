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
      include: { class: { select: { name: true, code: true } } },
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
        totalD += latest.scoreD;
        count++;
      }

      if (count === 0) {
        classOverview.push({ name: className, avgA: 0, avgB: 0, avgC: 0, avgD: 0, studentCount: stuList.length });
        continue;
      }

      const avgA = +(totalA / count).toFixed(1);
      const avgB = +(totalB / count).toFixed(1);
      const avgC = +(totalC / count).toFixed(1);
      const avgD = +(totalD / count).toFixed(1);

      classOverview.push({ name: className, avgA, avgB, avgC, avgD, studentCount: stuList.length });

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

    // ── 学生预警：综合偏差排名，每班取后 20% ──
    const studentAlerts: {
      studentId: string; studentName: string; class: string;
      dimension: string; score: number; classAvg: number; deviation: number;
      severity: "red" | "yellow";
    }[] = [];

    for (const [className, stuList] of classStudents) {
      if (stuList.length < 3) continue;

      const clsOverview = classOverview.find((c) => c.name === className);
      if (!clsOverview || clsOverview.avgA === 0) continue;
      const avgs = { A: clsOverview.avgA, B: clsOverview.avgB, C: clsOverview.avgC };

      // 每个学生的三维偏差 + 综合均值
      type Entry = { student: typeof students[0]; devA: number; devB: number; devC: number; avgDev: number; sA: number; sB: number; sC: number };
      const composite: Entry[] = [];

      for (const s of stuList) {
        const m = metricsByStudent.get(s.id)?.[0];
        if (!m) continue;
        const dA = +(m.scoreA - avgs.A).toFixed(1);
        const dB = +(m.scoreB - avgs.B).toFixed(1);
        const dC = +(m.scoreC - avgs.C).toFixed(1);
        composite.push({ student: s, devA: dA, devB: dB, devC: dC, avgDev: +((dA+dB+dC)/3).toFixed(1), sA: m.scoreA, sB: m.scoreB, sC: m.scoreC });
      }
      if (composite.length < 3) continue;

      composite.sort((a, b) => a.avgDev - b.avgDev);
      const total = composite.length;
      const redCut = Math.max(1, Math.ceil(total * 0.1));
      const ylwCut = Math.max(redCut + 1, Math.ceil(total * 0.2));

      const cutoff = (base: number) => {
        if (base >= total) return total;
        const max = Math.min(total, Math.ceil(base * 1.5));
        const v = composite[base - 1].avgDev;
        let i = base; while (i < max && composite[i].avgDev === v) i++;
        return i;
      };
      const redEnd = cutoff(redCut), ylwEnd = cutoff(ylwCut);

      const push = (e: Entry, sev: "red" | "yellow") => {
        const dims = ([["A", e.devA, e.sA], ["B", e.devB, e.sB], ["C", e.devC, e.sC]] as const)
          .filter(([, d]) => d < 0)
          .sort((a, b) => a[1] - b[1]);
        const worst = dims.length > 0 ? dims[0] : ["A", e.devA, e.sA] as const;
        studentAlerts.push({
          studentId: e.student.id, studentName: e.student.name,
          class: e.student.class.name ?? e.student.class.code,
          dimension: DIM_LABEL[worst[0]], score: worst[2],
          classAvg: avgs[worst[0]], deviation: worst[1], severity: sev,
        });
      };

      for (let i = 0; i < redEnd; i++) push(composite[i], "red");
      for (let i = redEnd; i < ylwEnd; i++) push(composite[i], "yellow");
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
