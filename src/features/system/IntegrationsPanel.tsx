import WeComWorkflowPanel from "@/components/wecom/WeComWorkflowPanel";
import LocalToolStatusPanel from "@/components/system/LocalToolStatusPanel";
import { PageHeader } from "@/components/ui";

export default function IntegrationsPanel() {
  return <main className="system-integrations-workspace"><PageHeader title="集成与本地工具" description="检查 WeComCatch、FunASR 及本机依赖，管理家校沟通导入。" /><LocalToolStatusPanel /><WeComWorkflowPanel title="企微家校沟通导入" description="同步、提取、预览并导入可用于课后反馈的家校沟通。" showFeedbackLink /></main>;
}
