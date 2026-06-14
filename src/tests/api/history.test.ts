import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { DELETE, GET, POST } from "@/app/api/history/route";

const title = "vitest-history";

afterEach(async () => {
  await prisma.workHistory.deleteMany({ where: { title } });
});

describe("/api/history", () => {
  it("creates, lists, and parses a persistent snapshot", async () => {
    const create = await POST(new NextRequest("http://localhost:3000/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "export", title, key: "range", state: { startDate: "2026-06-01" } }),
    }));
    expect(create.status).toBe(201);

    const list = await GET(new NextRequest("http://localhost:3000/api/history?module=export"));
    const rows = await list.json();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ title, state: { startDate: "2026-06-01" } }),
    ]));
  });

  it("deletes one history item by id", async () => {
    const row = await prisma.workHistory.create({ data: { module: "export", title, state: "{}" } });
    const response = await DELETE(new NextRequest(`http://localhost:3000/api/history?id=${row.id}`, { method: "DELETE" }));
    expect(response.status).toBe(200);
    expect(await prisma.workHistory.count({ where: { id: row.id } })).toBe(0);
  });

  it("rejects unknown modules", async () => {
    const response = await GET(new NextRequest("http://localhost:3000/api/history?module=unknown"));
    expect(response.status).toBe(400);
  });
});
