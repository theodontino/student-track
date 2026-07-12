import WeComWorkflowPanel from "@/components/wecom/WeComWorkflowPanel";
import LocalToolStatusPanel from "@/components/system/LocalToolStatusPanel";

export default function IntegrationsPanel() {
  return <div className="mx-auto max-w-5xl"><div className="mb-6"><h2 className="text-2xl font-bold text-gray-800">集成与本地工具</h2><p className="mt-1 text-sm text-gray-500">检查 WeComCatch、FunASR 及本机依赖，管理家校沟通导入。</p></div><LocalToolStatusPanel /><div className="mt-6"><WeComWorkflowPanel title="企微家校沟通导入" description="同步、提取、预览并导入可用于课后反馈的家校沟通。" showFeedbackLink /></div></div>;
}
