import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import * as XLSX from "xlsx";

export async function POST(request: NextRequest) {
  try {
    const { startDate, endDate, includeInactive = false } = await request.json();

    if (!startDate || !endDate) {
      return NextResponse.json({ error: "请选择时间范围" }, { status: 400 });
    }

    // v0.12: 分批查询防 OOM
    const BATCH_SIZE = 50;
    const sheet1Data: any[] = [];
    const sheet2Data: any[] = [];
    const sheet3Data: any[] = [];
    const sheet4Data: any[] = [];
    const sheet5Data: any[] = [];

    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const batch = await prisma.student.findMany({
        where: includeInactive === true ? undefined : { rosterStatus: "ACTIVE" },
        skip: page * BATCH_SIZE,
        take: BATCH_SIZE,
        include: {
          sessionMetrics: {
            where: { date: { gte: startDate, lte: endDate } },
            orderBy: { date: "desc" },
          },
          events: {
            where: { session: { date: { gte: startDate, lte: endDate } } },
            include: { session: { select: { date: true, code: true } } },
            orderBy: { createdAt: "desc" },
          },
          communications: {
            where: { session: { date: { gte: startDate, lte: endDate } } },
            include: { session: { select: { date: true, code: true } } },
            orderBy: { createdAt: "desc" },
          },
          attendances: {
            where: { session: { date: { gte: startDate, lte: endDate } } },
            include: { session: { select: { date: true, semesterNumber: true, code: true } } },
            orderBy: { session: { date: "desc" } },
          },
          class: { select: { code: true, name: true } },
          studentLabels: { include: { label: { select: { name: true } } } },
        },
      });

      for (const s of batch) {
        // Sheet 1: 学生档案
        sheet1Data.push({
          "姓名": s.name,
          "班级编码": s.class.code,
          "班级": s.class.name ?? s.class.code,
          "学号": s.studentId,
          "性别": s.gender,
          "花名册状态": s.rosterStatus === "ACTIVE" ? "在读" : "非活跃",
          "状态生效时间": s.statusEffectiveAt.toISOString(),
          "标签": (s.studentLabels || []).map((sl) => sl.label.name).join(", "),
          "当前状态": s.sessionMetrics.length > 0
            ? `A:${s.sessionMetrics[0].scoreA} B:${s.sessionMetrics[0].scoreB} C:${s.sessionMetrics[0].scoreC} D:${s.sessionMetrics[0].scoreD}`
            : "无记录",
        });

        // Sheet 2: 每日指标历史
        for (const m of s.sessionMetrics) {
          sheet2Data.push({
            "日期": m.date,
            "学生ID": s.studentId,
            "姓名": s.name,
            "维度A (学习&测验)": m.scoreA,
            "维度B (精神&纪律)": m.scoreB,
            "维度C (课后任务)": m.scoreC,
            "维度D (考勤)": m.scoreD,
            "操作人": m.operator,
          });
        }

        // Sheet 3: 关键事件日志
        for (const e of s.events) {
          sheet3Data.push({
            "日期": e.session.date,
            "学生ID": s.studentId,
            "姓名": s.name,
            "事件类型": e.type,
            "事件描述": e.description,
            "原始文本": e.rawText,
            "课次编码": e.session.code,
          });
        }

        // Sheet 4: 家校沟通记录
        for (const c of s.communications) {
          sheet4Data.push({
            "日期": c.session.date,
            "学生ID": s.studentId,
            "姓名": s.name,
            "沟通对象": c.target,
            "内容摘要": c.summary,
            "课次编码": c.session.code,
          });
        }

        // Sheet 5: 考勤记录
        for (const a of s.attendances || []) {
          sheet5Data.push({
            "日期": a.session.date,
            "学生ID": s.studentId,
            "姓名": s.name,
            "课次编码": a.session.code,
            "课次号": a.session.semesterNumber,
            "出勤状态": a.present ? "出勤" : "缺勤",
          });
        }
      }

      page++;
      hasMore = batch.length === BATCH_SIZE;
    }

    // Create workbook
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet1Data), "学生档案");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet2Data), "每日指标历史");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet3Data), "关键事件日志");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet4Data), "家校沟通记录");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet5Data), "考勤记录");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Student-Track_${startDate}_${endDate}.xlsx"`,
      },
    });
  } catch (error) {
    console.error("[/api/export] error:", error);
    return NextResponse.json({ error: "导出失败" }, { status: 500 });
  }
}
