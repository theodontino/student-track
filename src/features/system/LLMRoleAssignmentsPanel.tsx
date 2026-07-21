"use client";

import { Button, FormField, Section, Select, StatusBanner } from "@/components/ui";
import type { useLLMConfiguration } from "./useLLMConfiguration";

type Workspace = ReturnType<typeof useLLMConfiguration>;

export function LLMRoleAssignmentsPanel({ workspace }: { workspace: Workspace }) {
  return (
    <Section
      className="llm-role-assignments"
      title="模型角色分工"
      description="反馈分析、反馈成稿审核和企微结构化提取可分别指定模型；未指定时跟随当前启用配置。"
    >
      <div className="llm-role-assignments__body">
        <FormField id="llm-feedback-draft-role" label="分析模型（副 Agent）">
          <Select
            id="llm-feedback-draft-role"
            value={workspace.roleAssignments.feedbackDraftProfileId ?? ""}
            onChange={(event) => workspace.updateRole("feedbackDraftProfileId", event.target.value)}
          >
            <option value="">跟随当前启用配置</option>
            {workspace.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} / {profile.model}</option>)}
          </Select>
        </FormField>
        <FormField id="llm-feedback-review-role" label="成稿与审核模型（主 Agent）">
          <Select
            id="llm-feedback-review-role"
            value={workspace.roleAssignments.feedbackReviewProfileId ?? ""}
            onChange={(event) => workspace.updateRole("feedbackReviewProfileId", event.target.value)}
          >
            <option value="">跟随当前启用配置</option>
            {workspace.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} / {profile.model}</option>)}
          </Select>
        </FormField>
        <FormField id="llm-wecom-extraction-role" label="企微提取模型">
          <Select
            id="llm-wecom-extraction-role"
            value={workspace.roleAssignments.wecomExtractionProfileId ?? ""}
            onChange={(event) => workspace.updateRole("wecomExtractionProfileId", event.target.value)}
          >
            <option value="">跟随当前启用配置</option>
            {workspace.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} / {profile.model}</option>)}
          </Select>
        </FormField>
        {workspace.roleStatus && <StatusBanner tone="success">{workspace.roleStatus}</StatusBanner>}
        {workspace.roleError && <StatusBanner tone="danger">{workspace.roleError}</StatusBanner>}
        <Button onClick={() => void workspace.saveRoles()} disabled={workspace.roleSaving || workspace.loading}>
          {workspace.roleSaving ? "保存中…" : "保存模型分工"}
        </Button>
      </div>
    </Section>
  );
}
