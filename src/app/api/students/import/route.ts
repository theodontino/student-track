import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import * as XLSX from "xlsx";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "请上传文件" }, { status: 400 });
    }

    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "xlsx" && extension !== "csv") {
      return NextResponse.json({ error: "仅支持 .xlsx 或 .csv 文件" }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    const workbook = extension === "csv"
      ? XLSX.read(new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, ""), { type: "string" })
      : XLSX.read(buffer, { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    // Convert to JSON array
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
      defval: "",
    });

    if (rows.length === 0) {
      return NextResponse.json({ error: "文件中没有数据" }, { status: 400 });
    }

    // Detect columns (support both Chinese and English headers)
    const firstRow = rows[0];
    const headers = Object.keys(firstRow);
    const findHeader = (candidates: string[]) => headers.find((header) => candidates.includes(header.trim())) || "";

    const nameKey = findHeader(["姓名", "name", "Name"]);
    const classKey = findHeader(["班级", "班级编号", "class", "Class", "classCode"]);
    const studentIdKey = findHeader(["学号", "studentId", "student_id", "学籍号"]);
    const genderKey = findHeader(["性别", "gender", "Gender"]);

    if (!nameKey || !classKey || !studentIdKey) {
      return NextResponse.json(
        { error: `文件缺少必要列：${!nameKey ? "姓名, " : ""}${!classKey ? "班级编号, " : ""}${!studentIdKey ? "学号, " : ""}`.replace(/, $/, "") },
        { status: 400 }
      );
    }

    let successCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = String(row[nameKey] || "").trim();
      const classCode = String(row[classKey] || "").trim();
      const studentId = String(row[studentIdKey] || "").trim();
      const gender = genderKey ? String(row[genderKey] || "男").trim() : "男";

      if (!name || !classCode || !studentId) {
        errors.push(`第 ${i + 2} 行：缺少必填字段`);
        continue;
      }

      try {
        // Find or create class by code
        let cls = await prisma.class.findUnique({ where: { code: classCode } });
        if (!cls) {
          cls = await prisma.class.create({ data: { code: classCode } });
        }

        await prisma.student.create({
          data: {
            name,
            classId: cls.id,
            studentId,
            gender: ["男", "女"].includes(gender) ? gender : "男",
          },
        });
        successCount++;
      } catch (err: any) {
        if (err?.code === "P2002") {
          errors.push(`第 ${i + 2} 行：学号 ${studentId} 已存在`);
        } else {
          errors.push(`第 ${i + 2} 行：创建失败`);
        }
      }
    }

    return NextResponse.json({
      success: true,
      total: rows.length,
      successCount,
      errorCount: errors.length,
      errors: errors.slice(0, 10), // Only return first 10 errors
    });
  } catch (error) {
    console.error("[/api/students/import] error:", error);
    return NextResponse.json({ error: "导入失败，请检查文件格式" }, { status: 500 });
  }
}
