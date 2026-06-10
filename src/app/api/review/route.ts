import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { archiveMetricBeforeUpdate } from "@/lib/archive";
import { logAction } from "@/lib/logger";

// GET /api/review - list all drafts
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "pending";

    const drafts = await prisma.draftRecord.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(
      drafts.map((d) => ({
        ...d,
        parsedResult: JSON.parse(d.parsedResult),
        reviewResult: d.reviewResult ? JSON.parse(d.reviewResult) : null,
      }))
    );
  } catch (error) {
    console.error("GET /api/review error:", error);
    return NextResponse.json({ error: "获取草稿列表失败" }, { status: 500 });
  }
}

// POST /api/review - confirm or reject a draft
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { draftId, action, edits } = body;
    // action: "confirm" | "reject"
    // edits: optional, teacher-modified scores/events

    if (!draftId || !action) {
      return NextResponse.json({ error: "draftId 和 action 为必填项" }, { status: 400 });
    }

    const draft = await prisma.draftRecord.findUnique({ where: { id: draftId } });
    if (!draft) {
      return NextResponse.json({ error: "草稿不存在" }, { status: 404 });
    }

    if (action === "reject") {
      await prisma.draftRecord.update({
        where: { id: draftId },
        data: { status: "rejected" },
      });
      return NextResponse.json({ success: true, status: "rejected" });
    }

    // Confirm: write parsed data to database
    const parsedData = edits || JSON.parse(draft.parsedResult);
    const today = new Date().toISOString().split("T")[0];

    // v0.7: resolve sessionCode to sessionId
    let sessionId: string | null = null;
    let sessionMissing = false;
    if (draft.sessionCode) {
      const session = await prisma.classSession.findUnique({ where: { code: draft.sessionCode } });
      sessionId = session?.id ?? null;
      sessionMissing = !sessionId;
    }

    // v0.11.4: track warnings for silent drops
    const warnings: string[] = [];
    if (sessionMissing) {
      warnings.push(`关联课次 ${draft.sessionCode} 已被删除，评分已按无课次模式写入`);
    }

    for (const stu of parsedData.students) {
      // Find student by name (v0.11.4: 优先按班级限定，避免跨班同名错误)
      const student = await findStudentByName(stu.name, draft.sessionCode);

      if (!student) {
        console.warn(`Student not found: ${stu.name}, skipping`);
        continue;
      }

      // v0.7: write with sessionId if draft has sessionCode, else null
      if (stu.scores && Object.values(stu.scores).some((v) => v !== null)) {
        if (sessionId) {
          const existing = await prisma.sessionMetric.findUnique({
            where: { studentId_sessionId: { studentId: student.id, sessionId } },
          });
          if (existing) await archiveMetricBeforeUpdate(existing.id);
          await prisma.sessionMetric.upsert({
            where: { studentId_sessionId: { studentId: student.id, sessionId } },
            create: { studentId: student.id, date: today, sessionId, scoreA: stu.scores.A ?? 3, scoreB: stu.scores.B ?? 3, scoreC: stu.scores.C ?? 3, operator: "nl-review" },
            update: { scoreA: stu.scores.A ?? 3, scoreB: stu.scores.B ?? 3, scoreC: stu.scores.C ?? 3 },
          });
        } else {
          const existing = await prisma.sessionMetric.findFirst({
            where: { studentId: student.id, date: today, sessionId: null },
          });
          if (existing) {
            await archiveMetricBeforeUpdate(existing.id);
            await prisma.sessionMetric.update({
              where: { id: existing.id },
              data: { scoreA: stu.scores.A ?? 3, scoreB: stu.scores.B ?? 3, scoreC: stu.scores.C ?? 3 },
            });
          } else {
            await prisma.sessionMetric.create({
              data: { studentId: student.id, date: today, sessionId: null, scoreA: stu.scores.A ?? 3, scoreB: stu.scores.B ?? 3, scoreC: stu.scores.C ?? 3, operator: "nl-review" },
            });
          }
        }
      }

      // Create Events (only if sessionId available — binding to session required)
      if (stu.events && stu.events.length > 0) {
        if (sessionId) {
          for (const eventDesc of stu.events) {
            await prisma.event.create({
              data: {
                studentId: student.id,
                sessionId,
                type: inferEventType(eventDesc),
                description: eventDesc,
                rawText: draft.rawText,
              },
            });
          }
        } else {
          warnings.push(`${student.name} 的 ${stu.events.length} 个事件因无课次关联被跳过`);
        }
      }

      // Create Communication (only if sessionId available)
      if (stu.communication) {
        if (sessionId) {
          await prisma.communication.create({
            data: {
              studentId: student.id,
              sessionId,
              target: stu.communication.type.includes("家长") ? "家长" : stu.communication.type,
              summary: stu.communication.summary,
            },
          });
        } else {
          warnings.push(`${student.name} 的家校沟通记录因无课次关联被跳过`);
        }
      }
      // v0.11: log NL review score write
      if (stu.scores && Object.values(stu.scores).some((v) => v !== null)) {
        logAction({
          action: "score.updated",
          targetType: "Student",
          targetId: student.id,
          targetName: student.name,
          detail: { ...stu.scores, operator: "nl-review", sessionCode: draft.sessionCode },
        });
      }
    }

    await prisma.draftRecord.update({
      where: { id: draftId },
      data: {
        status: "confirmed",
        parsedResult: JSON.stringify(parsedData),
      },
    });

    return NextResponse.json({
      success: true,
      status: "confirmed",
      ...(warnings.length > 0 && { warnings }),
    });
  } catch (error) {
    console.error("POST /api/review error:", error);
    return NextResponse.json({ error: "操作失败" }, { status: 500 });
  }
}

function inferEventType(description: string): string {
  const lower = description.toLowerCase();
  if (lower.includes("测验") || lower.includes("考试") || lower.includes("成绩")) return "测验成绩";
  if (lower.includes("作业") || lower.includes("笔记") || lower.includes("预习")) return "课后任务";
  if (lower.includes("情绪") || lower.includes("心理") || lower.includes("低")) return "心理状态";
  if (lower.includes("家长") || lower.includes("电话") || lower.includes("沟通")) return "家校沟通";
  return "课堂表现";
}

// v0.11.4: 按班级限定查找学生，解决跨班同名错误
async function findStudentByName(name: string, sessionCode: string | null) {
  // 优先：通过课次编码反查班级范围
  if (sessionCode) {
    const session = await prisma.classSession.findUnique({
      where: { code: sessionCode },
      select: { classId: true },
    });
    if (session?.classId) {
      const student = await prisma.student.findFirst({
        where: { name, classId: session.classId },
      });
      if (student) return student;
    }
  }
  // 兜底：按名称无班级限定（旧 draft sessionCode 不存在或无须限制时）
  const student = await prisma.student.findFirst({ where: { name } });
  if (student) {
    console.warn(`[review] Student "${name}" matched without class scope — possible cross-class ambiguity`);
  }
  return student;
}
