import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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

    for (const stu of parsedData.students) {
      // Find student by name
      const student = await prisma.student.findFirst({
        where: { name: stu.name },
      });

      if (!student) {
        console.warn(`Student not found: ${stu.name}, skipping`);
        continue;
      }

      // Upsert DailyMetric (overwrite same date)
      if (stu.scores && Object.values(stu.scores).some((v) => v !== null)) {
        await prisma.dailyMetric.upsert({
          where: {
            studentId_date: {
              studentId: student.id,
              date: today,
            },
          },
          create: {
            studentId: student.id,
            date: today,
            scoreA: stu.scores.A ?? 3,
            scoreB: stu.scores.B ?? 3,
            scoreC: stu.scores.C ?? 3,
          },
          update: {
            scoreA: stu.scores.A ?? 3,
            scoreB: stu.scores.B ?? 3,
            scoreC: stu.scores.C ?? 3,
          },
        });
      }

      // Create Events
      if (stu.events && stu.events.length > 0) {
        for (const eventDesc of stu.events) {
          await prisma.event.create({
            data: {
              studentId: student.id,
              date: today,
              type: inferEventType(eventDesc),
              description: eventDesc,
              rawText: draft.rawText,
            },
          });
        }
      }

      // Create Communication
      if (stu.communication) {
        await prisma.communication.create({
          data: {
            studentId: student.id,
            date: today,
            target: stu.communication.type.includes("家长") ? "家长" : stu.communication.type,
            summary: stu.communication.summary,
          },
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

    return NextResponse.json({ success: true, status: "confirmed" });
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
