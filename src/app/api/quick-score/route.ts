import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface ScoreEntry {
  studentId: string;
  date: string;
  scoreA: number;
  scoreB: number;
  scoreC: number;
  note?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { scores } = body as { scores: ScoreEntry[] };

    if (!scores || !Array.isArray(scores) || scores.length === 0) {
      return NextResponse.json({ error: "请提交至少一条评分" }, { status: 400 });
    }

    let count = 0;

    for (const entry of scores) {
      // Validate
      if (!entry.studentId || !entry.date) continue;
      const a = Math.max(0, Math.min(5, entry.scoreA ?? 3));
      const b = Math.max(0, Math.min(5, entry.scoreB ?? 3));
      const c = Math.max(0, Math.min(5, entry.scoreC ?? 3));

      // Upsert DailyMetric
      await prisma.dailyMetric.upsert({
        where: {
          studentId_date: {
            studentId: entry.studentId,
            date: entry.date,
          },
        },
        create: {
          studentId: entry.studentId,
          date: entry.date,
          scoreA: a,
          scoreB: b,
          scoreC: c,
        },
        update: {
          scoreA: a,
          scoreB: b,
          scoreC: c,
        },
      });

      // Create Event from note
      if (entry.note && entry.note.trim()) {
        await prisma.event.create({
          data: {
            studentId: entry.studentId,
            date: entry.date,
            type: "课堂表现",
            description: entry.note.trim(),
            rawText: entry.note.trim(),
          },
        });
      }

      count++;
    }

    return NextResponse.json({ success: true, count });
  } catch (error) {
    console.error("POST /api/quick-score error:", error);
    return NextResponse.json({ error: "提交失败" }, { status: 500 });
  }
}
