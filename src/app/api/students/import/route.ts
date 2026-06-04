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

    // Read file buffer
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
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

    const nameKey = headers.find((h) => ["姓名", "name", "Name"].includes(h)) || "";
    const classKey = headers.find((h) => ["班级", "class", "Class"].includes(h)) || "";
    const studentIdKey = headers.find((h) => ["学号", "studentId", "student_id", "学籍号"].includes(h)) || "";
    const genderKey = headers.find((h) => ["性别", "gender", "Gender"].includes(h)) || "";

    if (!nameKey || !classKey || !studentIdKey) {
      return NextResponse.json(
        { error: `文件缺少必要列：${!nameKey ? "姓名, " : ""}${!classKey ? "班级, " : ""}${!studentIdKey ? "学号, " : ""}`.replace(/, $/, "") },
        { status: 400 }
      );
    }

    let successCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = String(row[nameKey] || "").trim();
      const className = String(row[classKey] || "").trim();
      const studentId = String(row[studentIdKey] || "").trim();
      const gender = genderKey ? String(row[genderKey] || "男").trim() : "男";

      if (!name || !className || !studentId) {
        errors.push(`第 ${i + 2} 行：缺少必填字段`);
        continue;
      }

      try {
        await prisma.student.create({
          data: {
            name,
            class: className,
            studentId,
            gender: ["男", "女"].includes(gender) ? gender : "男",
            labels: "[]",
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
    console.error("POST /api/students/import error:", error);
    return NextResponse.json({ error: "导入失败，请检查文件格式" }, { status: 500 });
  }
}
