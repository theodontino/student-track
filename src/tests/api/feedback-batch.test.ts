import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/report/feedback-batch/route";

const sessionCode = "VITEST-FEEDBACK";

afterEach(async () => {
  await prisma.workHistory.deleteMany({ where: { module: "feedback", key: sessionCode } });
});

describe("/api/report/feedback-batch", () => {
  it("rebuilds an Excel download from long-term history", async () => {
    await prisma.workHistory.create({
      data: {
        module: "feedback",
        key: sessionCode,
        title: "feedback test",
        state: JSON.stringify({
          kind: "batch",
          sessionCode,
          className: "测试班",
          total: 1,
          students: [{ id: "s1", name: "张三", labels: [], feedback: "本节课表现稳定。" }],
        }),
      },
    });

    const response = await GET(new NextRequest(`http://localhost:3000/api/report/feedback-batch?sessionCode=${sessionCode}&module=feedback`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("spreadsheetml");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });
});
