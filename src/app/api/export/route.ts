import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import * as XLSX from "xlsx";

export async function POST(request: NextRequest) {
  try {
    const { startDate, endDate } = await request.json();

    if (!startDate || !endDate) {
      return NextResponse.json({ error: "请选择时间范围" }, { status: 400 });
    }

    // Fetch data
    const students = await prisma.student.findMany({
      include: {
        metrics: {
          where: { date: { gte: startDate, lte: endDate } },
          orderBy: { date: "desc" },
        },
        events: {
          where: { date: { gte: startDate, lte: endDate } },
          orderBy: { date: "desc" },
        },
        communications: {
          where: { date: { gte: startDate, lte: endDate } },
          orderBy: { date: "desc" },
        },
        attendances: {
          where: { session: { date: { gte: startDate, lte: endDate } } },
          include: { session: { select: { date: true, semesterNumber: true, code: true } } },
          orderBy: { session: { date: "desc" } },
        },
      },
    });

    // Sheet 1: 学生档案
    const sheet1Data = students.map((s) => ({
      "姓名": s.name,
      "班级": s.class,
      "学号": s.studentId,
      "性别": s.gender,
      "标签": JSON.parse(s.labels).join(", "),
      "当前状态": s.metrics.length > 0
        ? `A:${s.metrics[0].scoreA} B:${s.metrics[0].scoreB} C:${s.metrics[0].scoreC} D:${s.metrics[0].scoreD}`
        : "无记录",
    }));

    // Sheet 2: 每日指标历史
    const sheet2Data: any[] = [];
    for (const s of students) {
      for (const m of s.metrics) {
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
    }

    // Sheet 3: 关键事件日志
    const sheet3Data: any[] = [];
    for (const s of students) {
      for (const e of s.events) {
        sheet3Data.push({
          "日期": e.date,
          "学生ID": s.studentId,
          "姓名": s.name,
          "事件类型": e.type,
          "事件描述": e.description,
          "原始文本": e.rawText,
        });
      }
    }

    // Sheet 4: 家校沟通记录
    const sheet4Data: any[] = [];
    for (const s of students) {
      for (const c of s.communications) {
        sheet4Data.push({
          "日期": c.date,
          "学生ID": s.studentId,
          "姓名": s.name,
          "沟通对象": c.target,
          "内容摘要": c.summary,
        });
      }
    }

    // Sheet 5: 考勤记录
    const sheet5Data: any[] = [];
    for (const s of students) {
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
        "Content-Disposition": `attachment; filename="Chem-Track_${startDate}_${endDate}.xlsx"`,
      },
    });
  } catch (error) {
    console.error("POST /api/export error:", error);
    return NextResponse.json({ error: "导出失败" }, { status: 500 });
  }
}
