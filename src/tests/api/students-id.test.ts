import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

// Resolve test student id from seed data
let testStudentId: string;

beforeAll(async () => {
  const student = await prisma.student.findFirst({
    where: { name: "张三" },
    select: { id: true },
  });
  testStudentId = student!.id;
});

describe("/api/students/[id]", () => {
  it("GET returns 200 with student detail", async () => {
    const { GET } = await import("@/app/api/students/[id]/route");
    const req = new NextRequest(`http://localhost:3000/api/students/${testStudentId}`);
    const res = await GET(req, { params: Promise.resolve({ id: testStudentId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("name", "张三");
    expect(body).toHaveProperty("studentId", "2024001");
    expect(body).toHaveProperty("sessionMetrics");
    expect(body).toHaveProperty("events");
  });

  it("GET nonexistent id returns 404", async () => {
    const { GET } = await import("@/app/api/students/[id]/route");
    const req = new NextRequest("http://localhost:3000/api/students/nonexistent");
    const res = await GET(req, { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("PUT returns 200 and updates labels", async () => {
    const { PUT } = await import("@/app/api/students/[id]/route");
    const req = new NextRequest(`http://localhost:3000/api/students/${testStudentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: ["#逻辑强", "#基础扎实", "#学霸"] }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: testStudentId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("name", "张三");
  });
});
