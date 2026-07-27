import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LLMSettings {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  reasoningEnabled?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  updatedAt?: string;
}

export interface LLMProfile extends LLMSettings {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type LLMProfileRole = "feedbackDraft" | "feedbackReview" | "wecomExtraction";

export interface LLMRoleAssignments {
  feedbackDraftProfileId: string | null;
  feedbackReviewProfileId: string | null;
  wecomExtractionProfileId: string | null;
}

export interface LLMSettingsStore {
  activeProfileId: string | null;
  profiles: LLMProfile[];
  roleAssignments: LLMRoleAssignments;
}

const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

function settingsPath() {
  return process.env.LLM_SETTINGS_PATH || path.join(process.cwd(), "data", "llm-settings.json");
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSettings(input: Partial<LLMSettings>): LLMSettings {
  return {
    apiBaseUrl: (input.apiBaseUrl || "").trim(),
    apiKey: (input.apiKey || "").trim(),
    model: (input.model || "").trim(),
    maxTokens: Number.isInteger(input.maxTokens) && (input.maxTokens as number) >= 256 && (input.maxTokens as number) <= 32768
      ? input.maxTokens
      : undefined,
    reasoningEnabled: typeof input.reasoningEnabled === "boolean" ? input.reasoningEnabled : undefined,
    reasoningEffort: input.reasoningEffort === "medium" || input.reasoningEffort === "high" || input.reasoningEffort === "low"
      ? input.reasoningEffort
      : "low",
    updatedAt: input.updatedAt,
  };
}

function normalizeProfile(input: Partial<LLMProfile>, fallbackName = "默认配置"): LLMProfile {
  const timestamp = nowIso();
  const settings = normalizeSettings(input);
  return {
    id: input.id || randomUUID(),
    name: (input.name || fallbackName).trim(),
    apiBaseUrl: settings.apiBaseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    maxTokens: settings.maxTokens,
    reasoningEnabled: settings.reasoningEnabled,
    reasoningEffort: settings.reasoningEffort,
    createdAt: input.createdAt || timestamp,
    updatedAt: input.updatedAt || timestamp,
  };
}

function emptyRoleAssignments(): LLMRoleAssignments {
  return {
    feedbackDraftProfileId: null,
    feedbackReviewProfileId: null,
    wecomExtractionProfileId: null,
  };
}

function normalizeRoleAssignments(value: unknown, profiles: LLMProfile[]): LLMRoleAssignments {
  const input = value && typeof value === "object" ? value as Partial<LLMRoleAssignments> : {};
  const profileIds = new Set(profiles.map((profile) => profile.id));
  return {
    feedbackDraftProfileId: typeof input.feedbackDraftProfileId === "string"
      && profileIds.has(input.feedbackDraftProfileId)
      ? input.feedbackDraftProfileId
      : null,
    feedbackReviewProfileId: typeof input.feedbackReviewProfileId === "string"
      && profileIds.has(input.feedbackReviewProfileId)
      ? input.feedbackReviewProfileId
      : null,
    wecomExtractionProfileId: typeof input.wecomExtractionProfileId === "string"
      && profileIds.has(input.wecomExtractionProfileId)
      ? input.wecomExtractionProfileId
      : null,
  };
}

function emptyStore(): LLMSettingsStore {
  return { activeProfileId: null, profiles: [], roleAssignments: emptyRoleAssignments() };
}

function parseStore(raw: any): LLMSettingsStore {
  if (Array.isArray(raw?.profiles)) {
    const profiles: LLMProfile[] = raw.profiles
      .map((profile: any, index: number) => normalizeProfile(profile, `配置 ${index + 1}`))
      .filter((profile: LLMProfile) => profile.apiBaseUrl || profile.apiKey || profile.model);
    const activeProfileId = profiles.some((profile) => profile.id === raw.activeProfileId)
      ? raw.activeProfileId
      : profiles[0]?.id ?? null;
    return {
      activeProfileId,
      profiles,
      roleAssignments: normalizeRoleAssignments(raw.roleAssignments, profiles),
    };
  }

  // Backward compatible with the previous single-profile JSON shape.
  const legacy = normalizeSettings(raw || {});
  if (!legacy.apiBaseUrl && !legacy.apiKey && !legacy.model) return emptyStore();
  const profile = normalizeProfile({ ...legacy, id: "default", name: "默认配置" });
  return { activeProfileId: profile.id, profiles: [profile], roleAssignments: emptyRoleAssignments() };
}

function readStore(): LLMSettingsStore {
  const filePath = settingsPath();
  if (!fs.existsSync(filePath)) return emptyStore();

  try {
    return parseStore(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    console.error("[llm-settings] failed to read settings:", error);
    return emptyStore();
  }
}

function writeStore(store: LLMSettingsStore) {
  const filePath = settingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function getLLMSettingsStore(): LLMSettingsStore {
  return readStore();
}

/** Returns role-specific settings, falling back to the active Web UI profile and then .env. */
export function getEffectiveLLMSettings(role?: LLMProfileRole): LLMSettings {
  const store = readStore();
  const assignedProfileId = role === "feedbackDraft"
    ? store.roleAssignments.feedbackDraftProfileId
    : role === "feedbackReview"
      ? store.roleAssignments.feedbackReviewProfileId
      : role === "wecomExtraction"
        ? store.roleAssignments.wecomExtractionProfileId
        : null;
  const activeProfile = store.profiles.find((profile) => profile.id === assignedProfileId)
    ?? store.profiles.find((profile) => profile.id === store.activeProfileId);
  return {
    apiBaseUrl: activeProfile?.apiBaseUrl || process.env.LLM_API_BASE_URL || DEFAULT_API_BASE_URL,
    apiKey: activeProfile?.apiKey || process.env.LLM_API_KEY || "",
    model: activeProfile?.model || process.env.LLM_MODEL || DEFAULT_MODEL,
    maxTokens: activeProfile?.maxTokens,
    reasoningEnabled: activeProfile?.reasoningEnabled,
    reasoningEffort: activeProfile?.reasoningEffort,
    updatedAt: activeProfile?.updatedAt,
  };
}

export function validateLLMSettings(input: Partial<LLMSettings>): LLMSettings {
  const settings = normalizeSettings(input);
  if (!settings.apiBaseUrl) throw new Error("请填写 API Base URL");
  if (!settings.apiKey) throw new Error("请填写 API Key");
  if (!settings.model) throw new Error("请填写模型名");
  if (input.maxTokens !== undefined && settings.maxTokens === undefined) {
    throw new Error("Max tokens 需在 256 到 32768 之间");
  }

  try {
    const url = new URL(settings.apiBaseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error("API Base URL 必须是有效的 http/https 地址");
  }

  return settings;
}

export function saveLLMProfile(input: Partial<LLMProfile>, activate = true): LLMSettingsStore {
  const settings = validateLLMSettings(input);
  const name = (input.name || "").trim();
  if (!name) throw new Error("请填写配置名称");

  const store = readStore();
  const existingIndex = input.id ? store.profiles.findIndex((profile) => profile.id === input.id) : -1;
  const previous = existingIndex >= 0 ? store.profiles[existingIndex] : null;
  const profile: LLMProfile = {
    id: previous?.id || input.id || randomUUID(),
    name,
    apiBaseUrl: settings.apiBaseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    maxTokens: settings.maxTokens,
    reasoningEnabled: settings.reasoningEnabled,
    reasoningEffort: settings.reasoningEffort,
    createdAt: previous?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };

  if (existingIndex >= 0) store.profiles[existingIndex] = profile;
  else store.profiles.push(profile);
  if (activate || !store.activeProfileId) store.activeProfileId = profile.id;

  writeStore(store);
  return store;
}

export function activateLLMProfile(profileId: string): LLMSettingsStore {
  const store = readStore();
  if (!store.profiles.some((profile) => profile.id === profileId)) throw new Error("配置不存在");
  store.activeProfileId = profileId;
  writeStore(store);
  return store;
}

export function saveLLMRoleAssignments(input: Partial<LLMRoleAssignments>): LLMSettingsStore {
  const store = readStore();
  const next = {
    feedbackDraftProfileId: input.feedbackDraftProfileId ?? null,
    feedbackReviewProfileId: input.feedbackReviewProfileId ?? null,
    wecomExtractionProfileId: input.wecomExtractionProfileId ?? null,
  };
  for (const profileId of [
    next.feedbackDraftProfileId,
    next.feedbackReviewProfileId,
    next.wecomExtractionProfileId,
  ]) {
    if (profileId && !store.profiles.some((profile) => profile.id === profileId)) {
      throw new Error("角色配置引用的 LLM 配置不存在");
    }
  }
  store.roleAssignments = next;
  writeStore(store);
  return store;
}

export function deleteLLMProfile(profileId: string): LLMSettingsStore {
  const store = readStore();
  const nextProfiles = store.profiles.filter((profile) => profile.id !== profileId);
  if (nextProfiles.length === store.profiles.length) throw new Error("配置不存在");
  store.profiles = nextProfiles;
  if (store.activeProfileId === profileId) store.activeProfileId = store.profiles[0]?.id ?? null;
  if (store.roleAssignments.feedbackDraftProfileId === profileId) {
    store.roleAssignments.feedbackDraftProfileId = null;
  }
  if (store.roleAssignments.feedbackReviewProfileId === profileId) {
    store.roleAssignments.feedbackReviewProfileId = null;
  }
  if (store.roleAssignments.wecomExtractionProfileId === profileId) {
    store.roleAssignments.wecomExtractionProfileId = null;
  }
  writeStore(store);
  return store;
}

export function clearLLMSettings() {
  const filePath = settingsPath();
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
