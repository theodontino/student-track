import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import packageMetadata from "../../../package.json";
import { GET } from "@/app/api/v1/system/health/route";
import { SystemHealthResponseSchema } from "@/lib/contracts/system";

describe("versioned system health API", () => {
  it("returns a stable, non-cached capability response", async () => {
    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(SystemHealthResponseSchema.parse(body)).toEqual({
      schemaVersion: 1,
      product: "student-track",
      appVersion: packageMetadata.version,
      apiVersion: "v1",
      status: "ok",
      capabilities: ["system.health.v1"],
    });
  });

  it("keeps the published synthetic fixture compatible", () => {
    const fixture = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "docs", "contracts", "examples", "system-health-v1.json"),
      "utf8",
    ));

    expect(SystemHealthResponseSchema.parse(fixture)).toEqual(fixture);
    expect(() => SystemHealthResponseSchema.parse({ ...fixture, schemaVersion: 2 })).toThrow();
    expect(() => SystemHealthResponseSchema.parse({ ...fixture, status: "degraded" })).toThrow();
  });
});
