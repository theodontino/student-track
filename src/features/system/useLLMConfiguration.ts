"use client";

import { useEffect, useMemo, useState } from "react";
import { requestJson } from "@/lib/api-client";
import { getProductCapabilities } from "@/lib/product-edition";
import {
  EMPTY_LLM_PROFILE,
  type LLMProfile,
  type LLMProfileForm,
  type LLMReasoningMode,
  type LLMRoleAssignments,
  type LLMSettingsResponse,
} from "./llm-types";

type DeleteMode = "current" | "all" | null;

export function roleAssignmentsRequestForEdition(
  roleAssignments: LLMRoleAssignments,
  includeWecomExtraction: boolean,
): Partial<LLMRoleAssignments> {
  if (includeWecomExtraction) return roleAssignments;
  return {
    feedbackDraftProfileId: roleAssignments.feedbackDraftProfileId,
    feedbackReviewProfileId: roleAssignments.feedbackReviewProfileId,
  };
}

export function useLLMConfiguration() {
  const capabilities = getProductCapabilities();
  const [profiles, setProfiles] = useState<LLMProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [form, setForm] = useState<LLMProfileForm>(EMPTY_LLM_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [deleteMode, setDeleteMode] = useState<DeleteMode>(null);
  const [roleAssignments, setRoleAssignments] = useState<LLMRoleAssignments>({
    feedbackDraftProfileId: null,
    feedbackReviewProfileId: null,
    wecomExtractionProfileId: null,
  });
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleStatus, setRoleStatus] = useState("");
  const [roleError, setRoleError] = useState("");

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, profiles],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadSettings() {
      setLoading(true);
      try {
        const data = await requestJson<LLMSettingsResponse>("/api/settings/llm");
        if (cancelled) return;
        setProfiles(data.profiles ?? []);
        setActiveProfileId(data.activeProfileId);
        setRoleAssignments(data.roleAssignments ?? {
          feedbackDraftProfileId: null,
          feedbackReviewProfileId: null,
          wecomExtractionProfileId: null,
        });
        const selected = data.profiles?.find((profile) => profile.id === data.activeProfileId) ?? data.profiles?.[0];
        if (selected) {
          setSelectedProfileId(selected.id);
          setForm({ ...selected });
        } else {
          setSelectedProfileId(null);
          setForm({
            ...EMPTY_LLM_PROFILE,
            apiBaseUrl: data.effectiveSettings?.apiBaseUrl || EMPTY_LLM_PROFILE.apiBaseUrl,
            apiKey: data.effectiveSettings?.apiKey || EMPTY_LLM_PROFILE.apiKey,
            model: data.effectiveSettings?.model || EMPTY_LLM_PROFILE.model,
          });
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "读取设置失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadSettings();
    return () => { cancelled = true; };
  }, []);

  function selectProfile(profile: LLMProfile) {
    setSelectedProfileId(profile.id);
    setForm({ ...profile });
    setModels([]);
    setStatus("");
    setError("");
  }

  function newProfile() {
    setSelectedProfileId(null);
    setForm(EMPTY_LLM_PROFILE);
    setModels([]);
    setStatus("");
    setError("");
  }

  function applyStore(data: LLMSettingsResponse, preferredId?: string) {
    setProfiles(data.profiles ?? []);
    setActiveProfileId(data.activeProfileId);
    setRoleAssignments(data.roleAssignments ?? {
      feedbackDraftProfileId: null,
      feedbackReviewProfileId: null,
      wecomExtractionProfileId: null,
    });
    const next = data.profiles?.find((profile) => profile.id === preferredId)
      ?? data.profiles?.find((profile) => profile.id === data.activeProfileId)
      ?? data.profiles?.[0];
    if (next) selectProfile(next);
    else newProfile();
  }

  function updateField(field: keyof LLMProfileForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setStatus("");
    setError("");
  }

  function updateGenerationField(
    field: "maxTokens" | "reasoningEnabled" | "reasoningEffort",
    value: number | boolean | "low" | "medium" | "high",
  ) {
    setForm((current) => ({ ...current, [field]: value }));
    setStatus("");
    setError("");
  }

  function updateReasoningMode(mode: LLMReasoningMode) {
    setForm((current) => {
      if (mode === "default") return { ...current, reasoningEnabled: undefined };
      if (mode === "none") return { ...current, reasoningEnabled: false };
      return { ...current, reasoningEnabled: true, reasoningEffort: mode };
    });
    setStatus("");
    setError("");
  }

  async function saveProfile(activate = true) {
    setSaving(true);
    setStatus("");
    setError("");
    try {
      const data = await requestJson<LLMSettingsResponse>("/api/settings/llm", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, id: selectedProfileId || form.id, activate }),
      });
      const saved = data.profiles?.find((profile) => (
        selectedProfileId ? profile.id === selectedProfileId : profile.name === form.name
      ));
      applyStore(data, saved?.id);
      setStatus(activate ? "已保存并启用。" : "已保存。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function activateProfile(id: string | null = selectedProfileId) {
    if (!id) return;
    setSaving(true);
    setStatus("");
    setError("");
    try {
      const data = await requestJson<LLMSettingsResponse>("/api/settings/llm", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeProfileId: id }),
      });
      applyStore(data, id);
      setStatus("已启用此配置。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "切换失败");
    } finally {
      setSaving(false);
    }
  }

  function updateRole(field: keyof LLMRoleAssignments, profileId: string) {
    setRoleAssignments((current) => ({ ...current, [field]: profileId || null }));
    setRoleStatus("");
    setRoleError("");
  }

  async function saveRoles() {
    setRoleSaving(true);
    setRoleStatus("");
    setRoleError("");
    try {
      const data = await requestJson<LLMSettingsResponse>("/api/settings/llm", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roleAssignments: roleAssignmentsRequestForEdition(
            roleAssignments,
            capabilities.wecomExtraction,
          ),
        }),
      });
      applyStore(data);
      setRoleStatus("模型分工已保存。");
    } catch (reason) {
      setRoleError(reason instanceof Error ? reason.message : "保存模型分工失败");
    } finally {
      setRoleSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteMode) return;
    setSaving(true);
    setStatus("");
    setError("");
    try {
      const url = deleteMode === "current" && selectedProfileId
        ? `/api/settings/llm?id=${encodeURIComponent(selectedProfileId)}`
        : "/api/settings/llm";
      const data = await requestJson<LLMSettingsResponse>(url, { method: "DELETE" });
      applyStore(data);
      setStatus(deleteMode === "current" ? "已删除配置。" : "已清除所有 Web UI 保存的配置。");
      setDeleteMode(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除设置失败");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setStatus("");
    setError("");
    setModels([]);
    try {
      const data = await requestJson<{ ok: boolean; models?: string[]; error?: string }>("/api/settings/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!data.ok) throw new Error(data.error || "连接失败");
      setModels(data.models ?? []);
      setStatus("连接成功。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "连接失败");
    } finally {
      setTesting(false);
    }
  }

  return {
    activeProfile,
    activeProfileId,
    activateProfile,
    confirmDelete,
    deleteMode,
    error,
    form,
    loading,
    models,
    newProfile,
    profiles,
    roleAssignments,
    roleError,
    roleSaving,
    roleStatus,
    saveProfile,
    saveRoles,
    saving,
    selectProfile,
    selectedProfileId,
    setDeleteMode,
    status,
    testConnection,
    testing,
    updateField,
    updateGenerationField,
    updateReasoningMode,
    updateRole,
  };
}
