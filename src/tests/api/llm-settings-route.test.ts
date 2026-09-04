import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH } from "@/app/api/settings/llm/route";
import {
  getLLMSettingsStore,
  saveLLMProfile,
  saveLLMRoleAssignments,
} from "@/lib/llm-settings";
import { roleAssignmentsRequestForEdition } from "@/features/system/useLLMConfiguration";

let tempDir = "";

function prepareProfiles() {
  const first = saveLLMProfile({
    name: "反馈草稿",
    apiBaseUrl: "http://localhost:1234/v1",
    apiKey: "synthetic-key",
    model: "draft-model",
  });
  const second = saveLLMProfile({
    name: "反馈复核",
    apiBaseUrl: "http://localhost:1234/v1",
    apiKey: "synthetic-key",
    model: "review-model",
  }, false);
  const draft = first.profiles.find((profile) => profile.name === "反馈草稿")!;
  const review = second.profiles.find((profile) => profile.name === "反馈复核")!;
  saveLLMRoleAssignments({
    feedbackDraftProfileId: draft.id,
    feedbackReviewProfileId: draft.id,
    wecomExtractionProfileId: review.id,
  });
  return { draft, review };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "student-track-llm-route-"));
  vi.stubEnv("LLM_SETTINGS_PATH", path.join(tempDir, "settings.json"));
  vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "full");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("/api/settings/llm Core edition", () => {
  it("masks the saved WCG role without modifying the settings file", async () => {
    const { review } = prepareProfiles();
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.roleAssignments.wecomExtractionProfileId).toBeNull();
    expect(getLLMSettingsStore().roleAssignments.wecomExtractionProfileId).toBe(review.id);
  });

  it("rejects an explicitly submitted WCG role with the unified feature response", async () => {
    const { draft, review } = prepareProfiles();
    const before = getLLMSettingsStore().roleAssignments;
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");

    const response = await PATCH(new NextRequest("http://localhost/api/settings/llm", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roleAssignments: {
          feedbackDraftProfileId: review.id,
          feedbackReviewProfileId: draft.id,
          wecomExtractionProfileId: null,
        },
      }),
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "当前 Core 版未包含此功能",
      code: "feature_unavailable",
      retryable: false,
    });
    expect(getLLMSettingsStore().roleAssignments).toEqual(before);
  });

  it("updates ordinary roles while preserving the hidden WCG assignment", async () => {
    const { draft, review } = prepareProfiles();
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");

    const response = await PATCH(new NextRequest("http://localhost/api/settings/llm", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roleAssignments: {
          feedbackDraftProfileId: review.id,
          feedbackReviewProfileId: draft.id,
        },
      }),
    }));
    const body = await response.json();
    const saved = getLLMSettingsStore();

    expect(response.status).toBe(200);
    expect(body.roleAssignments).toEqual({
      feedbackDraftProfileId: review.id,
      feedbackReviewProfileId: draft.id,
      wecomExtractionProfileId: null,
    });
    expect(saved.roleAssignments.wecomExtractionProfileId).toBe(review.id);
  });

  it("omits the WCG role from the Core UI request payload", () => {
    const roles = {
      feedbackDraftProfileId: "draft-id",
      feedbackReviewProfileId: "review-id",
      wecomExtractionProfileId: "wecom-id",
    };

    expect(roleAssignmentsRequestForEdition(roles, false)).toEqual({
      feedbackDraftProfileId: "draft-id",
      feedbackReviewProfileId: "review-id",
    });
    expect(roleAssignmentsRequestForEdition(roles, false)).not.toHaveProperty("wecomExtractionProfileId");
    expect(roleAssignmentsRequestForEdition(roles, true)).toEqual(roles);
  });
});
