"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import SemesterPicker from "@/components/SemesterPicker";
import { Badge, PageHeader, Section, StatusBanner } from "@/components/ui";
import { createEmptyLessonFeedbackMaterial } from "@/lib/feedback-materials";
import { requestJson } from "@/lib/api-client";
import EntryWorkspace from "@/features/entry/EntryWorkspace";
import { FeedbackBatchPanel } from "./FeedbackBatchPanel";
import FeedbackPlanManager from "./FeedbackPlanManager";
import { FeedbackPlanPanel, type FeedbackPlanWorkspace } from "./FeedbackPlanPanel";
import type { FeedbackIntakeRunClient } from "./feedback-task-types";
import { useFeedbackTaskContext } from "./useFeedbackTaskContext";

const tools = [
  ["manual-facts", "人工补录"], ["fact-editor", "事实编辑器"], ["pdf-manager", "PDF 管理"], ["materials", "公共材料"],
  ["plan-builder", "特殊计划"], ["manual-batch", "手工批次"], ["active-plans", "当前任务"], ["model-settings", "模型设置"],
] as const;

export default function FeedbackToolsWorkspace({ tool }: { tool: string }) {
  const context = useFeedbackTaskContext();
  const [run, setRun] = useState<FeedbackIntakeRunClient | null>(null);
  const [error, setError] = useState("");
  const currentTool = tools.some(([key]) => key === tool) ? tool : "active-plans";

  useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get("intakeRunId");
    if (!runId) { setRun(null); return; }
    requestJson<{ run: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(runId)}`).then((result) => setRun(result.run)).catch((reason) => setError(reason instanceof Error ? reason.message : "读取材料运行失败"));
  }, [context.context.sessionCode]);

  const planWorkspace = useMemo<FeedbackPlanWorkspace>(() => ({
    activeStep: "review", setActiveStep: () => undefined, draftId: "", confirmed: true,
    context: context.context,
    lessonMaterial: context.data?.groupProgress?.lesson?.confirmedMaterial ?? context.data?.sessionCommonMaterial?.material ?? createEmptyLessonFeedbackMaterial(context.context.sessionCode),
    contextStudents: context.data?.students ?? [], confirmedAssessmentEvidence: {},
  }), [context.context, context.data]);

  return <main className="feedback-workspace">
    <PageHeader title="高级工具" description="高级能力共用当前课次、材料运行和反馈任务，不再开启第二套步骤。" actions={<Link className="ui-button ui-button--ghost ui-button--md" href="/feedback">返回课后任务</Link>} />
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    {currentTool !== "manual-facts" && <Section title="教学上下文" description="工具只作用于这里选择的学期、班级和真实课次。"><SemesterPicker semesterId={context.context.semesterId} onSemesterChange={context.setSemesterId} className={context.context.className} onClassChange={context.setClassName} sessionCode={context.context.sessionCode} onSessionChange={context.setSessionCode} /></Section>}
    <nav className="feedback-tool-nav" aria-label="高级工具">{tools.map(([key, label]) => <Link key={key} href={`/feedback/tools?tool=${key}`} className={currentTool === key ? "is-active" : ""}>{label}</Link>)}</nav>
    {currentTool === "active-plans" && <FeedbackPlanManager semesterId={context.context.semesterId} />}
    {currentTool === "manual-batch" && <FeedbackBatchPanel initialSemesterId={context.context.semesterId} />}
    {currentTool === "plan-builder" && <FeedbackPlanPanel workspace={planWorkspace} />}
    {currentTool === "manual-facts" && <><Section title="人工课堂事实" description="人工录入和复核直接写入当前真实课次；助教表、STEP 和 ZIP 仍回到统一投料入口。"><div className="feedback-tool-actions"><Link className="ui-button ui-button--secondary ui-button--md" href={`/diarize?semesterId=${encodeURIComponent(context.context.semesterId)}&class=${encodeURIComponent(context.context.className)}&sessionCode=${encodeURIComponent(context.context.sessionCode)}`}>录音转写</Link><Link className="ui-button ui-button--ghost ui-button--md" href="/feedback">助教表 / STEP / ZIP 统一投料</Link></div></Section><EntryWorkspace /></>}
    {currentTool === "fact-editor" && <Section title="当前课次事实" description="这里浏览当前课次所有学生结构化事实；进入学生档案可做精细修改。"><div className="feedback-tool-grid">{(context.data?.students ?? []).map((student) => <article key={student.id}><div><strong>{student.name}</strong><Badge tone={student.preview.today.length ? "info" : "neutral"}>{student.preview.today.length} 条本课事实</Badge></div>{student.preview.today.length ? student.preview.today.map((fact) => <p key={fact}>{fact}</p>) : <p>暂无本课事实</p>}<Link href={`/students/${student.id}`}>打开学生档案 →</Link></article>)}</div></Section>}
    {currentTool === "pdf-manager" && <Section title="PDF 管理" description="PDF 属于当前 IntakeRun；重新绑定在核对阶段完成，不维护第二份客户端证据。">{run ? <><p>{run.sourceManifest.filter((source) => source.kind === "assessment_pdf").length} 份 PDF · {Object.keys(run.appliedSummary.assessmentEvidence ?? {}).length} 名学生已匹配</p><div className="feedback-tool-grid">{run.sourceManifest.filter((source) => source.kind === "assessment_pdf").map((source, index) => <article key={`${source.name}:${index}`}><strong>{source.name}</strong><span>当前运行：{run.status}</span></article>)}</div><Link className="ui-button ui-button--secondary ui-button--md" href={`/feedback?semesterId=${encodeURIComponent(context.context.semesterId)}&class=${encodeURIComponent(context.context.className)}&sessionCode=${encodeURIComponent(context.context.sessionCode)}&intakeRunId=${encodeURIComponent(run.id)}`}>返回统一核对</Link></> : <StatusBanner tone="info">当前 URL 没有 intakeRunId。请从课后任务或当前任务打开需要管理的材料运行。</StatusBanner>}</Section>}
    {currentTool === "materials" && <Section title="公共材料" description="公共材料只作为课程背景，确认修订后复制进任务快照。">{context.data?.groupProgress?.lesson?.confirmedMaterial ? <pre className="feedback-tool-material">{context.data.groupProgress.lesson.confirmedMaterial.groupFeedbackRaw}</pre> : context.data?.sessionCommonMaterial?.material ? <pre className="feedback-tool-material">{context.data.sessionCommonMaterial.material.groupFeedbackRaw}</pre> : <p>当前课次没有已确认公共材料。</p>}<Link className="ui-button ui-button--secondary ui-button--md" href={`/semesters?semesterId=${encodeURIComponent(context.context.semesterId)}`}>管理学期公共材料</Link></Section>}
    {currentTool === "model-settings" && <Section title="模型设置" description="模型配置保持单一来源，不在反馈工具中复制表单。"><Link className="ui-button ui-button--primary ui-button--md" href="/system/configuration">打开系统模型配置</Link></Section>}
  </main>;
}
