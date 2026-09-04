import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@/generated/prisma/client";
import { POST as postFeedbackPlanAction } from "@/app/api/report/feedback-plans/[id]/route";
import { buildWeComDraftPackage } from "@/services/feedback-export-service";
import {
  getProductCapabilities,
  parseProductEdition,
  productCapabilitiesFor,
} from "@/lib/product-edition";
import {
  isProductApiPathAvailable,
  requiredProductCapabilityForApiPath,
} from "@/lib/product-api-access";
import { proxy } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});
function localRequest(pathname: string) {
  return new NextRequest(`http://127.0.0.1:3000${pathname}`, {
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
    },
  });
}

describe("product edition", () => {
  it("defaults only an omitted edition to full and rejects every unsupported value", () => {
    expect(parseProductEdition(undefined)).toBe("full");
    expect(parseProductEdition("core")).toBe("core");
    expect(parseProductEdition("full")).toBe("full");
    expect(() => parseProductEdition("")).toThrow(/core 或 full/);
    expect(() => parseProductEdition("Core")).toThrow(/core 或 full/);
    expect(() => parseProductEdition("enterprise")).toThrow(/core 或 full/);
  });

  it("publishes the exact Core and Full capability descriptions", () => {
    expect(productCapabilitiesFor("core")).toEqual({
      edition: "core",
      audioTranscription: false,
      integrationSettings: false,
      localToolStatus: false,
      wecomDraftExport: false,
      wecomExtraction: false,
      wecomIntegration: false,
    });
    expect(productCapabilitiesFor("full")).toEqual({
      edition: "full",
      audioTranscription: true,
      integrationSettings: true,
      localToolStatus: true,
      wecomDraftExport: true,
      wecomExtraction: true,
      wecomIntegration: true,
    });

    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");
    expect(getProductCapabilities()).toEqual(productCapabilitiesFor("core"));
  });
});

describe("Core API boundary", () => {
  it.each([
    ["/api/diarize/tasks", "audioTranscription"],
    ["/api/diarize/tasks/test-task/retry", "audioTranscription"],
    ["/api/wecom/handoff", "wecomIntegration"],
    ["/api/wecom/review-drafts/preview/status", "wecomIntegration"],
    ["/api/integrations/wecomcatch/v1/directory", "wecomIntegration"],
    ["/api/system/local-tools", "localToolStatus"],
  ] as const)("maps and blocks %s", async (pathname, capability) => {
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");
    expect(requiredProductCapabilityForApiPath(pathname)).toBe(capability);
    expect(isProductApiPathAvailable(pathname)).toBe(false);

    const response = proxy(localRequest(pathname));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "当前 Core 版未包含此功能",
      code: "feature_unavailable",
      retryable: false,
    });
  });

  it("does not consume similar prefixes and keeps ordinary teaching APIs available", () => {
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");
    expect(requiredProductCapabilityForApiPath("/api/wecommunity")).toBeNull();
    expect(requiredProductCapabilityForApiPath("/api/system/local-tools-extra")).toBeNull();
    expect(isProductApiPathAvailable("/api/students")).toBe(true);

    const response = proxy(localRequest("/api/students"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects the feedback plan WeCom action before plan lookup", async () => {
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");
    const response = await postFeedbackPlanAction(new NextRequest("http://127.0.0.1:3000/api/report/feedback-plans/missing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "export_wecom_drafts" }),
    }), { params: Promise.resolve({ id: "missing" }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "当前 Core 版未包含此功能",
      code: "feature_unavailable",
      retryable: false,
    });
  });

  it("rejects direct WeCom package service calls before database access", async () => {
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");
    const findUnique = vi.fn();
    const database = { feedbackPlan: { findUnique } } as unknown as PrismaClient;

    await expect(buildWeComDraftPackage(database, "test-plan")).rejects.toMatchObject({
      status: 404,
      code: "feature_unavailable",
      message: "当前 Core 版未包含此功能",
    });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
