"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, PageHeader, StatusBanner, Textarea } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { FeedbackContextSection } from "./FeedbackContextSection";
import { useFeedbackWorkspace } from "./useFeedbackWorkspace";
import styles from "./unified-feedback-workspace.module.css";

interface FeedbackIntakeRunView {
  id: string;
  sessionCode: string;
  status: string;
  sourceFingerprint: string;
  sourceManifest: Array<Record<string, unknown>>;
  appliedSummary: Record<string, unknown>;
  issues: Array<{ id: string; code: string; message: string; sourceName?: string; severity: "requires_teacher" | "error" }>;
  planId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CommonLessonOption {
  id: string;
  title: string;
  revision: number;
  materialSnapshot: string;
  linkedToCurrent: boolean;
}

type ApiResult = { run: FeedbackIntakeRunView; inspection?: { summary?: Record<string, unknown>; assessmentEvidence?: Record<string, unknown> }; duplicate?: boolean };

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }

export default function UnifiedFeedbackWorkspace() {
  const workspace = useFeedbackWorkspace("prepare");
  const contextSemesterId = workspace.context.semesterId;
  const contextSessionCode = workspace.context.sessionCode;
  const [run, setRun] = useState<FeedbackIntakeRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [outputRequirement, setOutputRequirement] = useState("为每名入选学生生成一条可复核的家长反馈");
  const [generationMode, setGenerationMode] = useState<"standard" | "fast">("standard");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [commonLessonLabel, setCommonLessonLabel] = useState("");
  const [commonLessonOptions, setCommonLessonOptions] = useState<CommonLessonOption[]>([]);
  const [selectedCommonLessonId, setSelectedCommonLessonId] = useState("");
  const [autoScannedSession, setAutoScannedSession] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  async function refreshRun(id: string) {
    const result = await requestJson<{ run: FeedbackIntakeRunView }>(`/api/feedback/intake/runs/${encodeURIComponent(id)}`);
    setRun(result.run);
    return result.run;
  }

  const scanInbox = useCallback(async (silent = false) => {
    const sessionCode = workspace.context.sessionCode;
    if (!sessionCode) return;
    setBusy(true); setError(""); if (!silent) setStatus("正在扫描反馈收件箱…");
    try {
      const result = await requestJson<ApiResult>("/api/feedback/intake/scan", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionCode }),
      });
      setRun(result.run);
      setStatus(result.run.sourceManifest.length === 0 ? "反馈收件箱暂无材料；可以继续拖入或选择本次文件。" : result.run.status === "needs_review" ? "材料已读取；只有异常项需要处理。" : "材料已读取并应用，可以开始反馈。 ");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }, [workspace.context.sessionCode]);

  useEffect(() => {
    if (!workspace.contextHydrated || !workspace.context.sessionCode || autoScannedSession === workspace.context.sessionCode) return;
    setAutoScannedSession(workspace.context.sessionCode);
    void scanInbox(true);
  }, [autoScannedSession, scanInbox, workspace.context.sessionCode, workspace.contextHydrated]);

  useEffect(() => {
    const semesterId = contextSemesterId;
    const sessionCode = contextSessionCode;
    if (!semesterId || !sessionCode) { setCommonLessonLabel(""); setCommonLessonOptions([]); setSelectedCommonLessonId(""); return; }
    let cancelled = false;
    requestJson<{ groups: Array<{ lessons: Array<{ id: string; title: string; revisions: Array<{ id: string; revision: number; materialSnapshot: string }>; sessionLinks: Array<{ session: { code: string } }> }> }> }>(`/api/semesters/${encodeURIComponent(semesterId)}/class-groups`)
      .then((data) => {
        if (cancelled) return;
        const options = (data.groups ?? []).flatMap((group) => group.lessons ?? []).flatMap((lesson) => {
          const revision = lesson.revisions?.[0];
          if (!revision) return [];
          return [{ id: revision.id, title: lesson.title, revision: revision.revision, materialSnapshot: revision.materialSnapshot, linkedToCurrent: lesson.sessionLinks?.some((link) => link.session.code === sessionCode) ?? false }];
        });
        setCommonLessonOptions(options);
        const linked = options.find((option) => option.linkedToCurrent);
        setSelectedCommonLessonId(linked?.id ?? "");
        for (const group of data.groups ?? []) {
          for (const lesson of group.lessons ?? []) {
            if (lesson.sessionLinks?.some((link) => link.session.code === sessionCode) && lesson.revisions?.[0]) {
              setCommonLessonLabel(`${lesson.title} · 已确认修订 ${lesson.revisions[0].revision}`);
              return;
            }
          }
        }
        setCommonLessonLabel("");
      })
      .catch(() => { if (!cancelled) { setCommonLessonLabel(""); setCommonLessonOptions([]); setSelectedCommonLessonId(""); } });
    return () => { cancelled = true; };
  }, [contextSemesterId, contextSessionCode]);

  async function uploadFiles(files: FileList | null) {
    if (!workspace.context.sessionCode || !files?.length) return;
    setBusy(true); setError(""); setStatus("正在整理文件、ZIP 和目录材料…");
    try {
      const form = new FormData();
      form.set("sessionCode", workspace.context.sessionCode);
      Array.from(files).forEach((file) => form.append("files", file));
      const result = await requestJson<ApiResult>("/api/feedback/intake/upload", { method: "POST", body: form });
      setRun(result.run);
      setStatus(result.run.status === "needs_review" ? "材料已读取；请处理异常项。" : "材料已读取并应用，可以开始反馈。 ");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function createPlan() {
    if (!run) return;
    setBusy(true); setError(""); setStatus("正在创建 FeedbackPlan…");
    try {
      const selectedCommonLesson = commonLessonOptions.find((option) => option.id === selectedCommonLessonId);
      const selectedLessonMaterial = selectedCommonLesson
        ? (() => { try { return JSON.parse(selectedCommonLesson.materialSnapshot) as Record<string, unknown>; } catch { return undefined; } })()
        : undefined;
      const result = await requestJson<{ result: { plan?: { id: string } } }>(`/api/feedback/intake/runs/${encodeURIComponent(run.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_plan", plan: {
          type: "event_micro",
          outputRequirement,
          generationMode,
          lessonMaterial: selectedLessonMaterial ?? workspace.lessonMaterial,
        } }),
      });
      const next = await refreshRun(run.id);
      setRun(next);
      const planId = result.result.plan?.id;
      if (planId) {
        const assessmentEvidence = run.appliedSummary.assessmentEvidence;
        await requestJson(`/api/report/feedback-plans/${encodeURIComponent(planId)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start_generation", generationMode, assessmentEvidence: assessmentEvidence ?? {} }),
        });
        setStatus(generationMode === "fast" ? "快速草稿已开始生成，正在进入计划工作室。" : "标准反馈已开始生成，正在进入计划工作室。");
        window.location.assign(`/feedback/advanced?planId=${encodeURIComponent(planId)}`);
      } else {
        setStatus("FeedbackPlan 已创建。");
      }
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function resolveIssues() {
    if (!run) return;
    setBusy(true); setError("");
    try {
      const result = await requestJson<{ result: FeedbackIntakeRunView }>(`/api/feedback/intake/runs/${encodeURIComponent(run.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resolve" }),
      });
      setRun(result.result); setStatus("异常已标记为教师处理，未重新推断或补写事实。");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  const hasRun = Boolean(run && run.sourceManifest.length > 0);
  const issueCount = run?.issues.length ?? 0;
  const canStart = Boolean(hasRun && run && run.status !== "failed" && !busy);
  return <main className={styles.page}>
    <PageHeader
      title="课后任务"
      description="一次投入材料，自动应用无冲突事实，只把真正需要判断的项目留给教师。"
      actions={<div className={styles.headerActions}><Badge tone="info">1.2 Beta 3</Badge><Link href="/feedback/advanced" className="ui-button ui-button--ghost ui-button--md">高级工作台</Link></div>}
    />
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    {status && <StatusBanner tone="success">{status}</StatusBanner>}
    <FeedbackContextSection workspace={workspace} />
    <section className={styles.taskCard}>
      <header className={styles.taskHeader}><div><span className={styles.eyebrow}>统一材料入口</span><h2>把本次课后材料一次放进来</h2><p>拖拽、选择文件，或把材料放进固定收件箱。ZIP 只解开本次需要识别的文件；临时投入单次不超过 100MB。</p></div><div className={styles.headerStatus}>{run && run.sourceManifest.length === 0 ? <Badge tone="neutral">暂无材料</Badge> : hasRun ? <Badge tone={issueCount ? "warning" : "success"}>{issueCount ? `${issueCount} 项需处理` : "已应用"}</Badge> : <Badge tone="neutral">等待材料</Badge>}</div></header>
      <div className={styles.entrances}>
        <section className={styles.dropzone} onClick={() => uploadRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void uploadFiles(event.dataTransfer.files); }}>
          <span className={styles.eyebrow}>入口 A · 临时投入</span><strong>拖入文件、文件夹或 ZIP</strong><p>助教 Excel、STEP 文本、学生 PDF；ZIP 内支持这些文件类型。</p><Button variant="secondary" disabled={busy || !workspace.context.sessionCode}>选择材料</Button>
          <input ref={uploadRef} hidden type="file" multiple accept=".xlsx,.txt,.md,.step-classroom.txt,.pdf,.zip" onChange={(event) => { void uploadFiles(event.target.files); event.currentTarget.value = ""; }} />
        </section>
        <section className={styles.inbox}>
          <span className={styles.eyebrow}>入口 B · 固定目录</span><strong>读取反馈收件箱</strong><code>~/Library/Application Support/Student Track/feedback-inbox</code><Button variant="secondary" disabled={busy || !workspace.context.sessionCode} onClick={() => void scanInbox()}>重新扫描</Button><small>不移动、不删除原文件；只在教师打开本任务时读取。</small>
        </section>
      </div>
      <div className={styles.folderRow}><Button variant="ghost" uiSize="sm" onClick={() => folderRef.current?.click()} disabled={busy || !workspace.context.sessionCode}>选择整个报告文件夹</Button><span>适合一次导入一批学生 PDF；文件夹不会被持续监听。</span><input ref={folderRef} hidden type="file" multiple {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} accept=".pdf" onChange={(event) => { void uploadFiles(event.target.files); event.currentTarget.value = ""; }} /></div>
      {hasRun && run && <section className={styles.runSummary}><div><strong>本轮材料</strong><span>{run.sourceManifest.length} 个来源 · {run.appliedSummary && String((run.appliedSummary as { appliedStudentCount?: number }).appliedStudentCount ?? 0)} 名学生事实已整理</span></div><div className={styles.fileList}>{run.sourceManifest.map((file) => <span key={`${String(file.name)}:${String(file.size)}`}><Badge tone={file.kind === "ignored" ? "neutral" : file.kind === "assessment_pdf" ? "info" : "success"}>{file.kind === "ignored" ? "忽略" : file.kind === "assessment_pdf" ? "PDF" : file.kind === "step_classroom" ? "STEP" : "助教表"}</Badge>{String(file.name)}</span>)}</div></section>}
      {run && issueCount > 0 && <section className={styles.issues}><div><strong>只处理这些异常</strong><span>其余确定性内容已经应用；系统不会为异常项猜测学生、日期或事实。</span></div>{run.issues.map((item) => <article key={item.id}><Badge tone={item.severity === "error" ? "danger" : "warning"}>{item.code}</Badge><span>{item.message}</span><small>{item.sourceName ?? "本轮材料"}</small></article>)}<Button variant="ghost" onClick={() => void resolveIssues()} disabled={busy}>我已了解，继续进入反馈</Button></section>}
      <section className={styles.strategy}><div className={styles.strategyHeading}><div><strong>反馈策略</strong><span>批次设置仍可在计划工作室里逐学生覆盖。</span></div><Button variant="ghost" uiSize="sm" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? "收起高级设置" : "展开高级设置"}</Button></div>{commonLessonLabel && <p className={styles.commonLesson}>共同课公共材料：{commonLessonLabel}（创建计划时自动复制快照）</p>}{commonLessonOptions.length > 0 && <label className={styles.commonLessonPicker}>共同课公共材料<select value={selectedCommonLessonId} onChange={(event) => setSelectedCommonLessonId(event.target.value)}><option value="">不使用（若课次已有唯一关联则自动采用）</option>{commonLessonOptions.map((option) => <option key={option.id} value={option.id}>{option.title} · 修订 {option.revision}{option.linkedToCurrent ? " · 当前课次关联" : ""}</option>)}</select><small>{commonLessonLabel ? "当前课次存在唯一关联，已自动选中；仍可手动更换。" : "当前课次没有唯一关联，请手动选择；系统不会猜测。"}</small></label>}<div className={styles.strategyGrid}><label>生成方式<select value={generationMode} onChange={(event) => setGenerationMode(event.target.value as "standard" | "fast")}><option value="standard">标准反馈（含审核）</option><option value="fast">快速草稿（跳过审核润色）</option></select></label><label className={styles.requirement}>输出要求<Textarea rows={2} value={outputRequirement} onChange={(event) => setOutputRequirement(event.target.value)} /></label></div>{showAdvanced && <p className={styles.advancedNote}>共同课公共材料会从已确认修订自动带入；学生独立详略、语气、模块和正文编辑仍在高级工作台保留。</p>}</section>
      <footer className={styles.actions}><div><strong>{!run ? "先选择课次和材料" : issueCount ? "材料已应用，仍有异常可回查" : "材料已就绪"}</strong><span>开始后进入现有 FeedbackPlan 生成、复核和导出链路。</span></div><div>{run?.planId && <Link href={`/feedback/advanced?planId=${encodeURIComponent(run.planId)}`} className="ui-button ui-button--secondary ui-button--md">打开计划</Link>}<Button onClick={() => void createPlan()} disabled={!canStart || !outputRequirement.trim()}>{busy ? "处理中…" : generationMode === "fast" ? "快速生成草稿" : "开始标准反馈"}</Button></div></footer>
    </section>
  </main>;
}
