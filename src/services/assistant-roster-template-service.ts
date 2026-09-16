import * as XLSX from "xlsx";
import type { PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";

export async function buildAssistantRosterTemplate(prisma: PrismaClient, sessionCode: string) {
  const session = await prisma.classSession.findUnique({
    where: { code: sessionCode },
    include: {
      class: {
        include: {
          enrollments: {
            where: { rosterStatus: "ACTIVE" },
            include: { student: { select: { name: true, studentId: true } } },
          },
        },
      },
    },
  });
  if (!session) throw new ApiError("课次不存在", 404, "not_found", false);
  if (!session.class) throw new ApiError("全校课次不能生成班级助教评分表", 409, "conflict", false);
  const rows: Array<Array<string>> = [
    ["日期", session.date, "课次", String(session.semesterNumber)],
    ["姓名", "听课证号", "班级编号", "班级名称", "出入门测1-5", "课堂纪律1-5", "课后作业1-5", "备注"],
    ...session.class.enrollments
      .sort((left, right) => left.student.studentId.localeCompare(right.student.studentId, "zh-CN"))
      .map((enrollment) => [
        enrollment.student.name,
        enrollment.student.studentId,
        session.class!.code,
        session.class!.name ?? session.class!.code,
        "",
        "",
        "",
        "",
      ]),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = [{ wch: 14 }, { wch: 22 }, { wch: 16 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 42 }];
  worksheet["!autofilter"] = { ref: `A2:H${Math.max(2, rows.length)}` };
  worksheet["!freeze"] = { ySplit: 2 };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "课堂记录");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}
