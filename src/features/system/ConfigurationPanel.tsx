"use client";

import { ConfirmDialog, PageHeader } from "@/components/ui";
import { LLMProfileEditor } from "./LLMProfileEditor";
import { LLMProfileList } from "./LLMProfileList";
import { LLMRoleAssignmentsPanel } from "./LLMRoleAssignmentsPanel";
import { useLLMConfiguration } from "./useLLMConfiguration";
import { getProductCapabilities } from "@/lib/product-edition";

export default function ConfigurationPanel() {
  const workspace = useLLMConfiguration();
  const deletingAll = workspace.deleteMode === "all";
  return (
    <main className="system-configuration-workspace">
      <PageHeader title="LLM 配置" description="管理本地与备用模型连接。配置只用于本机工作区。" />
      <div className="system-configuration-grid"><LLMProfileList workspace={workspace} /><LLMProfileEditor workspace={workspace} /></div>
      <LLMRoleAssignmentsPanel workspace={workspace} showWecom={getProductCapabilities().wecomExtraction} />
      <ConfirmDialog
        open={Boolean(workspace.deleteMode)}
        title={deletingAll ? "清除全部 Web 配置" : "删除当前配置"}
        description={deletingAll ? "这会删除所有通过界面保存的 LLM 配置；环境变量不会被修改。" : `确定删除“${workspace.form.name}”吗？`}
        confirmLabel={deletingAll ? "全部清除" : "删除配置"}
        danger
        busy={workspace.saving}
        onConfirm={() => void workspace.confirmDelete()}
        onClose={() => { if (!workspace.saving) workspace.setDeleteMode(null); }}
      />
    </main>
  );
}
