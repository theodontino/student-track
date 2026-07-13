"use client";

import Link from "next/link";
import { Button, Section, StatusBanner, Textarea } from "@/components/ui";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;

export function ClassroomReviewComposer({ workspace }: { workspace: Workspace }) {
  return (
    <Section title="课堂回顾" description="可直接输入，也可以从录音转写页或助教 Excel 导入。" actions={<Link href="/diarize" className="feedback-text-link">录音转写</Link>}>
      <div className="feedback-composer">
        {workspace.parseStatus && !workspace.parsing && <StatusBanner tone="success">{workspace.parseStatus}</StatusBanner>}
        <Textarea value={workspace.rawText} onChange={(event) => workspace.setRawText(event.target.value)} placeholder="写下这节课对反馈有用的事实。未提及学生会按缺勤补齐。" rows={7} />
        <div className="feedback-assistant-import">
          <div><strong>助教 Excel</strong><p>把课堂纪律、作业、测验和备注转换为结构化课堂记录。</p></div>
          <label className={workspace.context.sessionCode && !workspace.assistantImporting ? "is-enabled" : ""}>{workspace.assistantImporting ? "导入中…" : "选择文件"}<input type="file" accept=".xlsx" multiple disabled={!workspace.context.sessionCode || workspace.assistantImporting} onChange={(event) => { void workspace.importAssistantRoster(event.target.files); event.currentTarget.value = ""; }} /></label>
        </div>
        <div className="feedback-composer__actions"><span>{workspace.rawText.length} 字</span><Button onClick={() => void workspace.parse()} disabled={!workspace.canParse}>{workspace.parsing ? workspace.parseStatus || "解析中…" : "解析课堂回顾"}</Button></div>
        {workspace.parsing && workspace.streamContent && <div className="feedback-stream" role="status">{workspace.streamContent}</div>}
      </div>
    </Section>
  );
}
