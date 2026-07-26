import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { requestJsonValidated } from "@/lib/api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestJsonValidated", () => {
  const responseSchema = z.object({ id: z.string().min(1), count: z.number().int() });

  it("returns a response only after runtime validation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "student-1", count: 2 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    await expect(requestJsonValidated(responseSchema, "/api/example")).resolves.toEqual({
      id: "student-1",
      count: 2,
    });
  });

  it("rejects a successful HTTP response with an invalid body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "", count: "2" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    await expect(requestJsonValidated(responseSchema, "/api/example")).rejects.toBeInstanceOf(z.ZodError);
  });
});
