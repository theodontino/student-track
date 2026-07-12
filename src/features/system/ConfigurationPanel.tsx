"use client";

import { useEffect, useMemo, useState } from "react";

interface LLMProfile {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

interface LLMSettingsResponse {
  activeProfileId: string | null;
  profiles: LLMProfile[];
  effectiveSettings: {
    apiBaseUrl: string;
    apiKey: string;
    model: string;
    updatedAt?: string;
  };
}

type LLMProfileForm = Partial<LLMProfile> & {
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
};

const EMPTY_FORM: LLMProfileForm = {
  name: "LM Studio",
  apiBaseUrl: "http://localhost:1234/v1",
  apiKey: "lm-studio",
  model: "",
};

export default function ConfigurationPanel() {
  const [profiles, setProfiles] = useState<LLMProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [form, setForm] = useState<LLMProfileForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [models, setModels] = useState<string[]>([]);

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, profiles]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      setLoading(true);
      try {
        const res = await fetch("/api/settings/llm");
        const data: LLMSettingsResponse = await res.json();
        if (cancelled) return;

        setProfiles(data.profiles || []);
        setActiveProfileId(data.activeProfileId);

        const selected = data.profiles?.find((profile) => profile.id === data.activeProfileId) ?? data.profiles?.[0];
        if (selected) {
          setSelectedProfileId(selected.id);
          setForm({
            id: selected.id,
            name: selected.name,
            apiBaseUrl: selected.apiBaseUrl,
            apiKey: selected.apiKey,
            model: selected.model,
            createdAt: selected.createdAt,
            updatedAt: selected.updatedAt,
          });
        } else {
          setSelectedProfileId(null);
          setForm({
            ...EMPTY_FORM,
            apiBaseUrl: data.effectiveSettings?.apiBaseUrl || EMPTY_FORM.apiBaseUrl,
            apiKey: data.effectiveSettings?.apiKey || EMPTY_FORM.apiKey,
            model: data.effectiveSettings?.model || EMPTY_FORM.model,
          });
        }
      } catch {
        if (!cancelled) setError("读取设置失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSettings();
    return () => { cancelled = true; };
  }, []);

  function applyStore(data: LLMSettingsResponse, preferredId?: string) {
    setProfiles(data.profiles || []);
    setActiveProfileId(data.activeProfileId);
    const next =
      data.profiles?.find((profile) => profile.id === preferredId) ??
      data.profiles?.find((profile) => profile.id === data.activeProfileId) ??
      data.profiles?.[0];

    if (next) selectProfile(next);
    else newProfile();
  }

  function selectProfile(profile: LLMProfile) {
    setSelectedProfileId(profile.id);
    setForm({
      id: profile.id,
      name: profile.name,
      apiBaseUrl: profile.apiBaseUrl,
      apiKey: profile.apiKey,
      model: profile.model,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
    setModels([]);
    setStatus("");
    setError("");
  }

  function newProfile() {
    setSelectedProfileId(null);
    setForm(EMPTY_FORM);
    setModels([]);
    setStatus("");
    setError("");
  }

  function updateField(field: keyof LLMProfileForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setStatus("");
    setError("");
  }

  async function saveProfile(activate = true) {
    setSaving(true);
    setStatus("");
    setError("");
    try {
      const res = await fetch("/api/settings/llm", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, id: selectedProfileId || form.id, activate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存失败");
      const saved = data.profiles?.find((profile: LLMProfile) =>
        selectedProfileId ? profile.id === selectedProfileId : profile.name === form.name
      );
      applyStore(data, saved?.id);
      setStatus(activate ? "已保存并启用。" : "已保存。");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "保存失败");
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
      const res = await fetch("/api/settings/llm", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeProfileId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "切换失败");
      applyStore(data, id);
      setStatus("已启用此配置。");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "切换失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteProfile() {
    if (!selectedProfileId) return;
    setSaving(true);
    setStatus("");
    setError("");
    try {
      const res = await fetch(`/api/settings/llm?id=${encodeURIComponent(selectedProfileId)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "删除失败");
      applyStore(data);
      setStatus("已删除配置。");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setSaving(false);
    }
  }

  async function clearAllProfiles() {
    setSaving(true);
    setStatus("");
    setError("");
    try {
      const res = await fetch("/api/settings/llm", { method: "DELETE" });
      const data = await res.json();
      applyStore(data);
      setStatus("已清除所有 Web UI 保存的配置。");
    } catch {
      setError("清除设置失败");
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
      const res = await fetch("/api/settings/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "连接失败");
      setModels(data.models || []);
      setStatus("连接成功。");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "连接失败");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">LLM 配置</h2>
        <p className="text-sm text-gray-500 mt-1">管理本地与备用模型连接。配置只用于本机工作区。</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-5">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-800">LLM 配置</h3>
            <button onClick={newProfile} className="text-sm text-blue-600 hover:text-blue-700">新增</button>
          </div>

          {loading ? (
            <div className="text-sm text-gray-500">读取中...</div>
          ) : profiles.length === 0 ? (
            <div className="text-sm text-gray-500">还没有保存的配置。</div>
          ) : (
            <div className="space-y-2">
              {profiles.map((profile) => {
                const selected = profile.id === selectedProfileId;
                const active = profile.id === activeProfileId;
                return (
                  <button
                    key={profile.id}
                    onClick={() => selectProfile(profile)}
                    className={`w-full text-left rounded-md border px-3 py-2 text-sm ${
                      selected ? "border-blue-300 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-800 truncate">{profile.name}</span>
                      {active && <span className="shrink-0 text-[11px] text-green-700 bg-green-50 border border-green-100 rounded px-1.5">启用</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-gray-500 truncate">{profile.model}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-5">
          <div>
            <h3 className="font-semibold text-gray-800">编辑配置</h3>
            <p className="text-sm text-gray-500 mt-1">
              LM Studio 默认地址通常是 http://localhost:1234/v1，API Key 可以填 lm-studio。
            </p>
          </div>

          {activeProfile && (
            <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
              当前启用：{activeProfile.name} / {activeProfile.model}
            </div>
          )}

          <label className="block">
            <span className="text-sm font-medium text-gray-700">配置名称</span>
            <input
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如 LM Studio 本地 / OpenAI 备用"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">API Base URL</span>
            <input
              value={form.apiBaseUrl}
              onChange={(e) => updateField("apiBaseUrl", e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="http://localhost:1234/v1"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">API Key</span>
            <input
              value={form.apiKey}
              onChange={(e) => updateField("apiKey", e.target.value)}
              type="password"
              className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="lm-studio"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">模型名</span>
            <input
              value={form.model}
              onChange={(e) => updateField("model", e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如 lmstudio-community/qwen2.5-7b-instruct"
            />
          </label>

          {form.updatedAt && (
            <p className="text-xs text-gray-400">上次保存：{new Date(form.updatedAt).toLocaleString()}</p>
          )}

          {status && <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{status}</div>}
          {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

          {models.length > 0 && (
            <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
              <div className="text-xs font-medium text-gray-500 mb-1">服务返回的模型</div>
              <div className="flex flex-wrap gap-2">
                {models.map((model) => (
                  <button
                    key={model}
                    type="button"
                    onClick={() => updateField("model", model)}
                    className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:border-blue-300 hover:text-blue-700"
                  >
                    {model}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3 pt-2">
            <button
              onClick={() => saveProfile(true)}
              disabled={saving}
              className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
            >
              {saving ? "保存中..." : "保存并启用"}
            </button>
            <button
              onClick={() => saveProfile(false)}
              disabled={saving}
              className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              仅保存
            </button>
            <button
              onClick={() => activateProfile()}
              disabled={saving || !selectedProfileId || selectedProfileId === activeProfileId}
              className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              启用此配置
            </button>
            <button
              onClick={testConnection}
              disabled={testing}
              className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {testing ? "测试中..." : "测试连接"}
            </button>
          </div>

          <div className="flex flex-wrap gap-3 border-t border-gray-100 pt-4">
            <button
              onClick={deleteProfile}
              disabled={saving || !selectedProfileId}
              className="px-4 py-2 rounded-md border border-red-200 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              删除当前配置
            </button>
            <button
              onClick={clearAllProfiles}
              disabled={saving}
              className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
            >
              清除全部 Web 配置
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}
