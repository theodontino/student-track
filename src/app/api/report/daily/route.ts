import { NextRequest, NextResponse } from "next/server";
import { TeachingSummaryRequestSchema } from "@/lib/contracts/teaching-summary";
import { generateTeachingSummary } from "@/services/teaching-summary-service";

// POST /api/report/daily — 按课次生成班级日报
export async function POST(request: NextRequest) {
  try {
    const { sessionCode } = await request.json();
    if (!sessionCode) {
      return NextResponse.json({ error: "缺少课次编码" }, { status: 400 });
    }

    const result = await generateTeachingSummary(TeachingSummaryRequestSchema.parse({
      scope: { type: "session", sessionCode },
      includeCommunications: true,
    }));
    const session = result.facts.sessions[0];
    const report = result.analysis?.overview
      || `本课次覆盖 ${result.facts.totals.coveredStudentCount} 名学生；评分记录 ${result.facts.totals.metricRecordedCount} 条，考勤记录 ${result.facts.totals.attendanceRecordedCount} 条。`;
    return NextResponse.json({
      report,
      sessionCode,
      className: session?.className ?? "",
      date: result.facts.date,
      studentCount: result.facts.totals.coveredStudentCount,
    });
  } catch (error) {
    console.error("[/api/report/daily] error:", error);
    return NextResponse.json({ error: "生成日报失败" }, { status: 500 });
  }
}
