"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Dialog, Section, StatusBanner } from "@/components/ui";
import { useWeComAccess } from "@/features/useWeComAccess";

export default function WeComAccessPanel({ openAfterAccept = true }: { openAfterAccept?: boolean }) {
  const router = useRouter();
  const access = useWeComAccess();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  function closeNotice() {
    setNoticeOpen(false);
    setConfirmed(false);
  }

  function acceptNotice() {
    if (!confirmed) return;
    access.setAccess(true);
    closeNotice();
    if (openAfterAccept) router.push("/wecom");
  }

  return <>
    <Section
      className="wecom-access-panel"
      title="企微家校工作区"
      description="WCG（WeComCatch GUI）是仓库外的可选第三方本地工具；阅读使用须知后，可启用独立工作区入口。"
      actions={access.hydrated && access.enabled ? <Badge tone="success">本机已启用</Badge> : <Badge tone="neutral">入口未启用</Badge>}
    >
      <div className="wecom-access-panel__body">
        <StatusBanner tone="warning">
          启用入口只表示本机操作者已阅读风险提示，不代表已自动取得聊天参与者、学生或监护人的授权。
        </StatusBanner>
        <div className="wecom-access-panel__actions">
          {access.enabled ? <>
            <Button onClick={() => router.push("/wecom")}>打开企微家校</Button>
            <Button variant="ghost" onClick={() => access.setAccess(false)}>隐藏左侧入口</Button>
          </> : <Button onClick={() => setNoticeOpen(true)}>阅读第三方工具使用须知</Button>}
        </div>
      </div>
    </Section>

    <Dialog open={noticeOpen} title="第三方工具使用须知" size="wide" onClose={closeNotice}>
      <div className="wecom-access-notice">
        <p>请在启用前确认以下边界。本须知用于明确操作者责任和数据流向，不构成法律意见，也不能替代应当取得的授权或同意。</p>
        <ol>
          <li><strong>第三方边界：</strong>WCG 不属于 Student Track，Student Track 不包含、分发、安装或更新其源码、配置和运行数据。</li>
          <li><strong>数据来源：</strong>只处理你有权访问且已获得适当授权的聊天记录，不导入与教学和家校沟通目的无关的内容。</li>
          <li><strong>未成年人信息：</strong>涉及学生、监护人或敏感个人信息时，应自行确认处理目的、必要性、告知和同意要求。</li>
          <li><strong>模型传输：</strong>若企微提取模型配置为云端 API，提交给模型的会话片段可能离开本机；需要纯本地处理时应使用受控的本地模型。</li>
          <li><strong>保存范围：</strong>Student Track 只保存 handoff 台账、用于教师复核的草案、经确认的沟通摘要和最小诊断元数据；聊天原文仍由外部工具管理。</li>
          <li><strong>人工复核：</strong>自动提取结果可能出错。系统先校验证据并唯一匹配学生，再生成待复核草案；教师选择实际课次并确认后，才会写入正式沟通。</li>
        </ol>
        <label className="wecom-access-notice__confirmation">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>我已阅读上述须知，并确认只会处理有合法来源和适当授权的数据。</span>
        </label>
        <div className="wecom-access-notice__actions">
          <Button variant="secondary" onClick={closeNotice}>暂不启用</Button>
          <Button disabled={!confirmed} onClick={acceptNotice}>确认并启用入口</Button>
        </div>
      </div>
    </Dialog>
  </>;
}
