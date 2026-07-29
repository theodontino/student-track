import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateLLMProfile,
  clearLLMSettings,
  deleteLLMProfile,
  getEffectiveLLMSettings,
  getLLMSettingsStore,
  saveLLMProfile,
  saveLLMRoleAssignments,
  validateLLMSettings,
} from "@/lib/llm-settings";
import { getLLMCompletionOptions } from "@/lib/llm";

let tempDir = "";
const originalEnv = {
  LLM_SETTINGS_PATH: process.env.LLM_SETTINGS_PATH,
  LLM_API_BASE_URL: process.env.LLM_API_BASE_URL,
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL,
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "student-track-llm-settings-"));
  process.env.LLM_SETTINGS_PATH = path.join(tempDir, "settings.json");
  process.env.LLM_API_BASE_URL = "https://env.example/v1";
  process.env.LLM_API_KEY = "env-key";
  process.env.LLM_MODEL = "env-model";
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.env.LLM_SETTINGS_PATH = originalEnv.LLM_SETTINGS_PATH;
  process.env.LLM_API_BASE_URL = originalEnv.LLM_API_BASE_URL;
  process.env.LLM_API_KEY = originalEnv.LLM_API_KEY;
  process.env.LLM_MODEL = originalEnv.LLM_MODEL;
});

describe("llm-settings", () => {
  it("uses active Web UI profile before environment values", () => {
    saveLLMProfile({
      name: "Local",
      apiBaseUrl: "http://localhost:1234/v1",
      apiKey: "lm-studio",
      model: "local-model",
    });

    expect(getEffectiveLLMSettings()).toMatchObject({
      apiBaseUrl: "http://localhost:1234/v1",
      apiKey: "lm-studio",
      model: "local-model",
    });
  });

  it("persists model token and reasoning controls with safe defaults", () => {
    saveLLMProfile({
      name: "Local",
      apiBaseUrl: "http://localhost:1234/v1",
      apiKey: "lm-studio",
      model: "local-model",
      maxTokens: 8192,
      reasoningEnabled: true,
      reasoningEffort: "medium",
    });
    expect(getEffectiveLLMSettings()).toMatchObject({
      maxTokens: 8192,
      reasoningEnabled: true,
      reasoningEffort: "medium",
    });
    expect(() => validateLLMSettings({
      apiBaseUrl: "http://localhost:1234/v1", apiKey: "x", model: "m", maxTokens: 12,
    })).toThrow("Max tokens");
  });

  it("distinguishes model-default, disabled, and enabled reasoning modes", () => {
    const base = {
      name: "Local",
      apiBaseUrl: "http://localhost:1234/v1",
      apiKey: "lm-studio",
      model: "local-model",
    };
    let store = saveLLMProfile(base);
    expect(getLLMCompletionOptions("feedbackDraft", 2048)).not.toHaveProperty("reasoning_effort");

    store = saveLLMProfile({
      ...store.profiles[0],
      reasoningEnabled: false,
    });
    expect(getLLMCompletionOptions("feedbackDraft", 2048))
      .toMatchObject({ reasoning_effort: "none" });
    expect(getLLMCompletionOptions(undefined, 2048)).not.toHaveProperty("reasoning_effort");

    saveLLMProfile({
      ...store.profiles[0],
      reasoningEnabled: true,
      reasoningEffort: "high",
    });
    expect(getLLMCompletionOptions("feedbackDraft", 2048))
      .toMatchObject({ reasoning_effort: "high" });
  });

  it("falls back to environment values after clearing saved settings", () => {
    saveLLMProfile({
      name: "Local",
      apiBaseUrl: "http://localhost:1234/v1",
      apiKey: "lm-studio",
      model: "local-model",
    });
    clearLLMSettings();

    expect(getEffectiveLLMSettings()).toMatchObject({
      apiBaseUrl: "https://env.example/v1",
      apiKey: "env-key",
      model: "env-model",
    });
  });

  it("saves multiple profiles and switches the active one", () => {
    saveLLMProfile({
      name: "Local",
      apiBaseUrl: "http://localhost:1234/v1",
      apiKey: "lm-studio",
      model: "local-model",
    });
    const store = saveLLMProfile({
      name: "Cloud",
      apiBaseUrl: "https://api.example/v1",
      apiKey: "cloud-key",
      model: "cloud-model",
    }, false);

    expect(store.profiles).toHaveLength(2);
    expect(getEffectiveLLMSettings().model).toBe("local-model");

    const cloud = getLLMSettingsStore().profiles.find((profile) => profile.name === "Cloud");
    activateLLMProfile(cloud!.id);

    expect(getEffectiveLLMSettings()).toMatchObject({
      apiBaseUrl: "https://api.example/v1",
      apiKey: "cloud-key",
      model: "cloud-model",
    });
  });

  it("assigns separate feedback and WeCom extraction profiles with active fallback", () => {
    const draftStore = saveLLMProfile({
      name: "Draft",
      apiBaseUrl: "http://localhost:1234/v1",
      apiKey: "draft-key",
      model: "draft-model",
    });
    const reviewStore = saveLLMProfile({
      name: "Review",
      apiBaseUrl: "https://review.example/v1",
      apiKey: "review-key",
      model: "review-model",
    }, false);
    const draft = draftStore.profiles.find((profile) => profile.name === "Draft")!;
    const review = reviewStore.profiles.find((profile) => profile.name === "Review")!;

    saveLLMRoleAssignments({
      feedbackDraftProfileId: draft.id,
      feedbackReviewProfileId: review.id,
      wecomExtractionProfileId: review.id,
    });

    expect(getEffectiveLLMSettings("feedbackDraft").model).toBe("draft-model");
    expect(getEffectiveLLMSettings("feedbackReview").model).toBe("review-model");
    expect(getEffectiveLLMSettings("wecomExtraction").model).toBe("review-model");

    const afterDelete = deleteLLMProfile(review.id);
    expect(afterDelete.roleAssignments.feedbackReviewProfileId).toBeNull();
    expect(afterDelete.roleAssignments.wecomExtractionProfileId).toBeNull();
    expect(getEffectiveLLMSettings("feedbackReview").model).toBe("draft-model");
  });

  it("rejects incomplete or invalid settings", () => {
    expect(() => validateLLMSettings({ apiBaseUrl: "localhost:1234", apiKey: "x", model: "m" })).toThrow("http/https");
    expect(() => validateLLMSettings({ apiBaseUrl: "http://localhost:1234/v1", apiKey: "", model: "m" })).toThrow("API Key");
    expect(() => validateLLMSettings({ apiBaseUrl: "http://localhost:1234/v1", apiKey: "x", model: "" })).toThrow("模型名");
  });
});
