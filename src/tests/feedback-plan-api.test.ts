import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const planMocks = vi.hoisted(() => ({
  updateDraft: vi.fn(),
  rename: vi.fn(),
  clone: vi.fn(),
}));

vi.mock("@/services/feedback-plan-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/feedback-plan-service")>(),
  updateFeedbackPlanDraft: planMocks.updateDraft,
  renameFeedbackPlan: planMocks.rename,
  cloneFeedbackPlanDraft: planMocks.clone,
  toFeedbackPlanDetail: (plan: unknown) => plan,
}));
vi.mock("@/services/academic-scope-recycle-service", () => ({
  assertFeedbackPlanAvailable: vi.fn().mockResolvedValue({ id: "plan-1" }),
}));

import { PATCH, POST } from "@/app/api/report/feedback-plans/[id]/route";

const context = { params: Promise.resolve({ id: "plan-1" }) };

function request(method: "PATCH" | "POST", body: unknown) {
  return new NextRequest("http://localhost/api/report/feedback-plans/plan-1", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("feedback plan API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planMocks.updateDraft.mockResolvedValue({ id: "plan-1", planRevision: 2 });
    planMocks.rename.mockResolvedValue({ id: "plan-1", displayName: "第二版", planRevision: 3 });
    planMocks.clone.mockResolvedValue({ id: "plan-2", basedOnPlanId: "plan-1", displayName: null, status: "draft" });
  });

  it("routes a parsed plan_draft patch and rename separately from item edits", async () => {
    const saved = await PATCH(request("PATCH", {
      action: "plan_draft",
      patch: {
        displayName: "  周末复盘  ",
        outputRequirement: "突出进步",
        generationMode: "fast",
        studentIds: ["student-1"],
        expectedPlanRevision: 1,
      },
    }), context);
    expect(saved.status).toBe(200);
    expect(planMocks.updateDraft).toHaveBeenCalledWith("plan-1", {
      displayName: "周末复盘",
      outputRequirement: "突出进步",
      generationMode: "fast",
      studentIds: ["student-1"],
      expectedPlanRevision: 1,
    });

    const renamed = await PATCH(request("PATCH", { action: "rename", displayName: "第二版", expectedPlanRevision: 2 }), context);
    expect(renamed.status).toBe(200);
    expect(planMocks.rename).toHaveBeenCalledWith("plan-1", { displayName: "第二版", expectedPlanRevision: 2 });
  });

  it("creates a separate unnamed clone draft through clone_draft", async () => {
    const response = await POST(request("POST", { action: "clone_draft" }), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ plan: { id: "plan-2", basedOnPlanId: "plan-1", displayName: null, status: "draft" } });
    expect(planMocks.clone).toHaveBeenCalledWith({ planId: "plan-1" });
  });

  it("rejects an empty plan patch before calling the service", async () => {
    const response = await PATCH(request("PATCH", { action: "plan_draft", patch: { expectedPlanRevision: 1 } }), context);
    expect(response.status).toBe(400);
    expect(planMocks.updateDraft).not.toHaveBeenCalled();
  });
});
