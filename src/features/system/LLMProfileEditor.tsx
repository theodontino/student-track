"use client";

import { Button, FormField, Input, Section, Select, StatusBanner } from "@/components/ui";
import type { useLLMConfiguration } from "./useLLMConfiguration";

type Workspace = ReturnType<typeof useLLMConfiguration>;

export function LLMProfileEditor({ workspace }: { workspace: Workspace }) {
  return (
    <Section title="编辑配置" description="LM Studio 默认地址通常是 http://localhost:1234/v1，API Key 可以填 lm-studio。">
      <div className="llm-profile-editor">
        {workspace.activeProfile && <StatusBanner tone="success">当前启用：{workspace.activeProfile.name} / {workspace.activeProfile.model}</StatusBanner>}
        <FormField id="llm-profile-name" label="配置名称"><Input id="llm-profile-name" value={workspace.form.name} onChange={(event) => workspace.updateField("name", event.target.value)} placeholder="例如 LM Studio 本地 / OpenAI 备用" /></FormField>
        <FormField id="llm-api-base" label="API Base URL"><Input id="llm-api-base" value={workspace.form.apiBaseUrl} onChange={(event) => workspace.updateField("apiBaseUrl", event.target.value)} placeholder="http://localhost:1234/v1" /></FormField>
        <FormField id="llm-api-key" label="API Key"><Input id="llm-api-key" type="password" value={workspace.form.apiKey} onChange={(event) => workspace.updateField("apiKey", event.target.value)} placeholder="lm-studio" autoComplete="off" /></FormField>
        <FormField id="llm-model" label="模型名"><Input id="llm-model" value={workspace.form.model} onChange={(event) => workspace.updateField("model", event.target.value)} placeholder="例如 lmstudio-community/qwen2.5-7b-instruct" /></FormField>
        <FormField id="llm-max-tokens" label="Max tokens"><Input id="llm-max-tokens" type="number" min="256" max="32768" value={String(workspace.form.maxTokens ?? 4096)} onChange={(event) => workspace.updateGenerationField("maxTokens", Number(event.target.value) || 0)} /></FormField>
        <FormField
          id="llm-reasoning-mode"
          label="模型思考"
          description="模型默认不传 reasoning_effort；关闭会在反馈与企微角色调用中显式传入 none。"
        >
          <Select
            id="llm-reasoning-mode"
            value={workspace.form.reasoningEnabled === undefined
              ? "default"
              : workspace.form.reasoningEnabled
                ? workspace.form.reasoningEffort ?? "low"
                : "none"}
            onChange={(event) => workspace.updateReasoningMode(event.target.value as "default" | "none" | "low" | "medium" | "high")}
          >
            <option value="default">模型默认</option>
            <option value="none">关闭</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </Select>
        </FormField>
        {workspace.form.updatedAt && <p className="llm-profile-editor__updated">上次保存：{new Date(workspace.form.updatedAt).toLocaleString()}</p>}
        {workspace.status && <StatusBanner tone="success">{workspace.status}</StatusBanner>}
        {workspace.error && <StatusBanner tone="danger">{workspace.error}</StatusBanner>}
        {workspace.models.length > 0 && <div className="llm-model-options"><strong>服务返回的模型</strong><div>{workspace.models.map((model) => <button key={model} type="button" onClick={() => workspace.updateField("model", model)}>{model}</button>)}</div></div>}
        <div className="llm-profile-editor__primary-actions"><Button onClick={() => void workspace.saveProfile(true)} disabled={workspace.saving}>{workspace.saving ? "保存中…" : "保存并启用"}</Button><Button variant="secondary" onClick={() => void workspace.saveProfile(false)} disabled={workspace.saving}>仅保存</Button><Button variant="secondary" onClick={() => void workspace.activateProfile()} disabled={workspace.saving || !workspace.selectedProfileId || workspace.selectedProfileId === workspace.activeProfileId}>启用此配置</Button><Button variant="secondary" onClick={() => void workspace.testConnection()} disabled={workspace.testing}>{workspace.testing ? "测试中…" : "测试连接"}</Button></div>
        <div className="llm-profile-editor__danger-actions"><Button variant="danger" onClick={() => workspace.setDeleteMode("current")} disabled={workspace.saving || !workspace.selectedProfileId}>删除当前配置</Button><Button variant="ghost" onClick={() => workspace.setDeleteMode("all")} disabled={workspace.saving || workspace.profiles.length === 0}>清除全部 Web 配置</Button></div>
      </div>
    </Section>
  );
}
