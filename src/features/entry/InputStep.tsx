"use client";

import { useRouter } from "next/navigation";
import WorkHistoryButton from "@/components/WorkHistoryButton";
import SemesterPicker from "@/components/SemesterPicker";
import { Button, Section, StatusBanner, Textarea } from "@/components/ui";
import { ParseResultPreview, ReviewSummary } from "./draft-components";
import { useInputWorkspace, type InputHistoryState } from "./useInputWorkspace";

const INPUT_PLACEHOLDER = "例如：今天张三测验氧化还原全对，但上课走神。李四作业没交，情绪低落。给王五的妈妈打了电话讨论近况。";

export default function InputStep({ onReview }: { onReview?: () => void }) {
  const router = useRouter();
  const workspace = useInputWorkspace();
  const { context, rawText, setRawText, loading, result, error } = workspace;

  function openReview() {
    if (onReview) onReview();
    else router.push("/entry?step=review");
  }

  return (
    <div className="entry-input-workspace">
      <div className="entry-step-heading">
        <div><h2>自然语言录入</h2><p>用自然语言描述学生表现，系统会生成待人工确认的结构化草案。</p></div>
        <WorkHistoryButton<InputHistoryState> module="input" onRestore={workspace.restoreHistory} />
      </div>

      <Section title="教学上下文" description="草案会绑定到所选课次；未提及学生将按现有规则补齐考勤。">
        <div className="entry-context-panel">
          <SemesterPicker
            semesterId={context.semesterId}
            onSemesterChange={workspace.setSemesterId}
            className={context.className}
            onClassChange={workspace.setClassName}
            sessionCode={context.sessionCode}
            onSessionChange={workspace.setSessionCode}
          />
          {context.sessionCode && <StatusBanner tone="info">将关联到课次 {context.sessionCode}</StatusBanner>}
        </div>
      </Section>

      <Section title="课堂记录" description="只写事实和观察；解析结果不会自动写入正式档案。">
        <div className="entry-composer">
          <Textarea value={rawText} onChange={(event) => setRawText(event.target.value)} placeholder={INPUT_PLACEHOLDER} rows={6} />
          <div className="entry-composer__actions">
            <span>{rawText.length} 字符</span>
            <Button uiSize="lg" onClick={() => void workspace.submit()} disabled={loading || !rawText.trim() || !context.sessionCode}>{loading ? "LLM 分析中…" : "提交分析"}</Button>
          </div>
        </div>
      </Section>

      {error && <StatusBanner tone="danger">{error}</StatusBanner>}
      {result && <>
        <StatusBanner tone="success">解析成功，草案已保存。<Button variant="ghost" uiSize="sm" onClick={openReview}>前往复核中心</Button></StatusBanner>
        {result.corrections?.length ? <Section title="姓名修正" description="请在确认写入前核对自动匹配结果。"><div className="entry-corrections">{result.corrections.map((correction, index) => <div key={`${correction.original}-${index}`}><span>{correction.original}</span><strong>→ {correction.corrected}</strong><small>{correction.confidence}</small></div>)}</div></Section> : null}
        <ReviewSummary review={result.reviewResult} />
        <ParseResultPreview result={result.parsedResult} />
      </>}
    </div>
  );
}
