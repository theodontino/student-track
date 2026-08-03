import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/export/route";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { TEST_FIXTURE } from "../../../scripts/test-fixture-data";

describe("/api/export", () => {
  it("POST without dates returns 400", async () => {
    const req = new NextRequest("http://localhost:3000/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("POST with dates returns 200 with xlsx", async () => {
    const req = new NextRequest("http://localhost:3000/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: "2026-06-01", endDate: "2026-06-10" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("excludes inactive students by default and includes their unchanged history on request", async () => {
    const studentId = TEST_FIXTURE.students[1].id;
    await prisma.student.update({
      where: { id: studentId },
      data: { enrollments: { update: { where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } }, data: { rosterStatus: "INACTIVE", statusEffectiveAt: new Date("2026-07-29T00:00:00.000Z") } } } },
    });
    try {
      const exportRows = async (includeInactive: boolean) => {
        const response = await POST(new NextRequest("http://localhost:3000/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startDate: "2026-01-01",
            endDate: "2026-12-31",
            includeInactive,
          }),
        }));
        expect(response.status).toBe(200);
        const workbook = XLSX.read(await response.arrayBuffer(), { type: "array" });
        return XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["学生档案"]);
      };
      expect((await exportRows(false)).some((row) => row["学号"] === TEST_FIXTURE.students[1].studentId)).toBe(false);
      const included = (await exportRows(true)).find((row) => row["学号"] === TEST_FIXTURE.students[1].studentId);
      expect(included).toMatchObject({ "花名册状态": "非活跃" });
      expect(included?.["状态生效时间"]).toContain("2026-07-29");
    } finally {
      await prisma.student.update({
        where: { id: studentId },
        data: { enrollments: { update: { where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } }, data: { rosterStatus: "ACTIVE", statusEffectiveAt: new Date() } } } },
      });
    }
  });
});
