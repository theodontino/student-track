"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, PageHeader, SegmentedControl, StatusBanner, Textarea } from "@/components/ui";
import styles from "./feedback-workflow-demo.module.css";

type DemoView = "intake" | "review" | "studio";
type Length = "inherit" | "short" | "standard" | "detailed";
type Tone = "inherit" | "gentle" | "professional";

const students = [
  { id: "s1", name: "张三", status: "needs_review", note: "STEP 与助教表有一处课堂纪律描述需要确认", tone: "跟随公共设置", length: "跟随公共设置" },
  { id: "s2", name: "李四", status: "ready", note: "事实完整，出门测已匹配", tone: "温和", length: "简洁" },
  { id: "s3", name: "王五", status: "approved", note: "正文已保存并批准", tone: "专业", length: "详细" },
] as const;

const files = [
  { label: "助教课堂记录.xlsx", detail: "28 名学生 · 已识别", tone: "success" as const },
  { label: "STEP-课堂-第12次.txt", detail: "17 条课堂事实 · 已识别", tone: "success" as const },
  { label: "出门测报告文件夹", detail: "28 份 PDF · 27 份自动匹配", tone: "warning" as const },
  { label: "共同课修订 3", detail: "已确认 · 自动采用", tone: "info" as const },
];

const viewLabels: Record<DemoView, string> = {
  intake: "收集材料",
  review: "确认事实",
  studio: "计划工作室",
};

function draftFor(studentName: string) {
  return `${studentName}今天在课堂前半段经过提醒后很快调整了状态，后半段能够持续跟上推导，也认真完成了出门测订正。整体来看，他正在逐渐形成更稳定的课堂节奏。`;
}

export function FeedbackWorkflowDemo() {
  const [view, setView] = useState<DemoView>("intake");
  const [length, setLength] = useState<Length>("inherit");
  const [tone, setTone] = useState<Tone>("inherit");
  const [selectedStudentId, setSelectedStudentId] = useState("s1");
  const [showSettings, setShowSettings] = useState(false);
  const [inboxScanned, setInboxScanned] = useState(false);
  const [showStudentSettings, setShowStudentSettings] = useState(false);
  const [studentLength, setStudentLength] = useState<Length>("inherit");
  const [studentTone, setStudentTone] = useState<Tone>("inherit");
  const [draft, setDraft] = useState(() => draftFor(students[0].name));
  const [saved, setSaved] = useState(false);
  const [generationMode, setGenerationMode] = useState<"standard" | "fast">("standard");
  const selectedStudent = useMemo(() => students.find((student) => student.id === selectedStudentId) ?? students[0], [selectedStudentId]);

  function advance(mode: "standard" | "fast" = generationMode) {
    setGenerationMode(mode);
    setView((current) => current === "intake" ? "review" : "studio");
  }

  return <main className={styles.page}>
    <PageHeader
      title="课后任务 · UX Demo"
      description="一次投料、一次事实确认，然后进入可完整微操的反馈计划。仅为交互演示，不读取或写入真实数据。"
      actions={<Link href="/feedback" className="ui-button ui-button--ghost ui-button--md">返回现有工作台</Link>}
    />

    <div className={styles.demoNotice}><Badge tone="info">1.2 Beta 3 概念稿</Badge><span>可以随意点击；刷新后重置。</span></div>

    <section className={styles.taskShell}>
      <header className={styles.taskHeader}>
        <div>
          <span className={styles.eyebrow}>当前课后任务</span>
          <h2>高二化学 A 班 · 第 12 次课</h2>
          <p>2026-08-13 · 事件型反馈 · 28 名学生</p>
        </div>
        <div className={styles.taskState}><span>当前阶段</span><strong>{viewLabels[view]}</strong></div>
      </header>

      <nav className={styles.taskRail} aria-label="Demo 场景">
        {(["intake", "review", "studio"] as DemoView[]).map((item, index) => <button key={item} type="button" className={view === item ? styles.activeRail : ""} onClick={() => setView(item)}><span>{index + 1}</span><strong>{viewLabels[item]}</strong></button>)}
      </nav>

      {view === "intake" && <div className={styles.content}>
        <div className={styles.materialEntrances}>
          <section className={styles.dropzone}>
            <div><span className={styles.eyebrow}>入口 A · 临时投入</span><strong>拖入文件、文件夹或 ZIP</strong><p>支持助教 Excel、STEP 文本、学生 PDF；ZIP 解开后按相同规则识别。</p></div>
            <Button variant="secondary">选择文件、文件夹或 ZIP</Button>
          </section>
          <section className={styles.inboxCard}>
            <div><span className={styles.eyebrow}>入口 B · 固定目录</span><strong>读取反馈收件箱</strong><p><code>~/Library/Application Support/Student Track/feedback-inbox</code></p></div>
            <Button variant="secondary" onClick={() => setInboxScanned(true)}>{inboxScanned ? "重新扫描" : "扫描收件箱"}</Button>
            {inboxScanned && <small>发现 1 个助教表、1 个 STEP 文件、28 份 PDF；等待统一核对。</small>}
          </section>
        </div>

        <div className={styles.fileGrid}>{files.map((file) => <article key={file.label} className={styles.fileCard}><div><strong>{file.label}</strong><span>{file.label.startsWith("共同课") ? "从 1.2 已确认修订自动带入 · 可更换" : file.detail}</span></div><Badge tone={file.tone}>{file.label.startsWith("共同课") ? "公共材料" : file.tone === "warning" ? "1 项需处理" : "就绪"}</Badge></article>)}</div>

        <section className={styles.strategyCard}>
          <div className={styles.strategyHeading}><div><strong>本次反馈策略</strong><p>默认跟随家庭偏好；整批设置后仍可为个别学生覆盖。</p></div><Button variant="ghost" uiSize="sm" onClick={() => setShowSettings((value) => !value)}>{showSettings ? "收起计划设置" : "展开全部计划设置"}</Button></div>
          <div className={styles.strategyRows}>
            <label>详略<SegmentedControl label="反馈详略" value={length} onChange={(value) => setLength(value as Length)} items={[{ value: "inherit", label: "随家庭偏好" }, { value: "short", label: "简洁" }, { value: "standard", label: "标准" }, { value: "detailed", label: "详细" }]} /></label>
            <label>语气<SegmentedControl label="反馈语气" value={tone} onChange={(value) => setTone(value as Tone)} items={[{ value: "inherit", label: "随家庭偏好" }, { value: "gentle", label: "温和" }, { value: "professional", label: "专业" }]} /></label>
          </div>
          {showSettings && <div className={styles.advancedGrid}>
            <label><span>反馈类型</span><select defaultValue="event"><option value="event">事件型微反馈</option><option>阶段趋势反馈</option><option>结课教学总结</option></select></label>
            <label><span>结尾</span><select defaultValue="recognition"><option value="recognition">具体认可</option><option>课堂已处理</option><option>家庭配合</option><option>后续观察</option></select></label>
            <label className={styles.requirement}><span>总体要求与补充事实</span><Textarea rows={3} defaultValue="自然记录本次最值得家长了解的课堂表现，优先使用已经确认的具体事实。" /></label>
            <div className={styles.moduleSummary}><span>模块</span><strong>具体表现 · 教师判断</strong><button type="button">调整模块</button></div>
          </div>}
        </section>

        <footer className={styles.primaryActions}>
          <div><strong>材料基本就绪</strong><span>有 2 项异常需要确认，系统会在下一步自动定位。</span></div>
          <div><Button variant="secondary" onClick={() => advance("fast")}>快速生成草稿</Button><Button onClick={() => advance("standard")}>检查并开始标准反馈</Button></div>
        </footer>
      </div>}

      {view === "review" && <div className={styles.content}>
        <div className={styles.summaryStrip}><div><strong>45</strong><span>已合并事实</span></div><div><strong>27</strong><span>PDF 自动匹配</span></div><div><strong>2</strong><span>需要教师判断</span></div><div><strong>0</strong><span>阻断项</span></div></div>
        <StatusBanner tone="warning">只处理下面两项，其余已识别内容可通过“查看全部事实”核对。</StatusBanner>
        <div className={styles.issueList}>
          <article><header><div><Badge tone="warning">来源冲突</Badge><strong>张三 · 课堂纪律</strong></div><button type="button">查看原始来源</button></header><p>助教表记录“提醒后恢复”，STEP 记录“后半段持续专注”。两者可以并存，也可以由教师修改。</p><div className={styles.choiceRow}><label><input type="radio" name="conflict" defaultChecked /> 合并为一次完整观察</label><label><input type="radio" name="conflict" /> 仅采用 STEP</label><label><input type="radio" name="conflict" /> 手动编辑</label></div></article>
          <article><header><div><Badge tone="warning">需要匹配</Badge><strong>1 份出门测 PDF</strong></div><button type="button">忽略本次报告</button></header><p>文件“测试学生-订正版.pdf”没有唯一匹配结果。</p><select defaultValue=""><option value="">选择学生</option><option>张三</option><option>李四</option><option>王五</option></select></article>
        </div>
        <details className={styles.allFacts}><summary>查看全部已整理事实（45）</summary><p>公共材料 6 条 · 助教记录 22 条 · STEP 课堂观察 17 条。这里将保留完整编辑入口。</p></details>
        <footer className={styles.primaryActions}><div><strong>确认后将固定本次事实快照</strong><span>随后创建同一个 FeedbackPlan，并按所选方式启动队列。</span></div><div><Button variant="ghost" onClick={() => setView("intake")}>返回材料</Button><Button onClick={() => advance()}>确认事实并开始{generationMode === "fast" ? "快速" : "标准"}反馈</Button></div></footer>
      </div>}

      {view === "studio" && <div className={styles.studio}>
        <aside className={styles.studentNav}>
          <div><span className={styles.eyebrow}>计划导航</span><strong>下一条需处理</strong><p>2/3 已生成 · 1 条需确认</p></div>
          <div className={styles.filterChips}><button type="button" className={styles.activeChip}>待处理 1</button><button type="button">待批准 1</button><button type="button">已完成 1</button></div>
          <div className={styles.studentList}>{students.map((student) => <button type="button" key={student.id} className={student.id === selectedStudentId ? styles.activeStudent : ""} onClick={() => { setSelectedStudentId(student.id); setDraft(draftFor(student.name)); setSaved(student.status === "approved"); setShowStudentSettings(false); }}><span><strong>{student.name}</strong><small>{student.note}</small></span><Badge tone={student.status === "approved" ? "success" : student.status === "needs_review" ? "warning" : "info"}>{student.status === "approved" ? "已批准" : student.status === "needs_review" ? "需处理" : "待批准"}</Badge></button>)}</div>
        </aside>
        <section className={styles.studentDetail}>
          <header><div><span className={styles.eyebrow}>当前学生</span><h3>{selectedStudent.name}</h3><p>{studentTone === "inherit" ? selectedStudent.tone : studentTone === "gentle" ? "温和" : "专业"} · {studentLength === "inherit" ? selectedStudent.length : studentLength === "short" ? "简洁" : studentLength === "standard" ? "标准" : "详细"} · {generationMode === "fast" ? "快速草稿" : "标准生成"}</p></div><div><Button variant="secondary" uiSize="sm" onClick={() => setShowStudentSettings((value) => !value)}>{showStudentSettings ? "收起独立设置" : "学生独立设置"}</Button><Button variant="ghost" uiSize="sm" onClick={() => { setGenerationMode("standard"); setDraft(draftFor(selectedStudent.name)); setSaved(false); }}>按标准模式重生成</Button></div></header>
          {showStudentSettings && <section className={styles.studentSettings} aria-label={`${selectedStudent.name}的独立设置`}>
            <div><strong>仅覆盖 {selectedStudent.name}</strong><span>不改变本批其他学生，也可以随时恢复跟随公共设置。</span></div>
            <label>详略<SegmentedControl label="学生反馈详略" value={studentLength} onChange={(value) => setStudentLength(value as Length)} items={[{ value: "inherit", label: "跟随公共" }, { value: "short", label: "简洁" }, { value: "standard", label: "标准" }, { value: "detailed", label: "详细" }]} /></label>
            <label>语气<SegmentedControl label="学生反馈语气" value={studentTone} onChange={(value) => setStudentTone(value as Tone)} items={[{ value: "inherit", label: "跟随公共" }, { value: "gentle", label: "温和" }, { value: "professional", label: "专业" }]} /></label>
          </section>}
          {selectedStudent.status === "needs_review" && <StatusBanner tone="warning">程序核验要求确认一处来源表述；正文仍可继续编辑。</StatusBanner>}
          <div className={styles.reviewGrid}>
            <div className={styles.evidenceColumn}><section><strong>本课事实</strong><p>课堂前半段经提醒后恢复状态；后半段能够持续跟随推导，并完成出门测订正。</p></section><section><strong>最近趋势</strong><p>学习表现较前两次稳定，课堂纪律仍需要一次提醒。</p></section><section><strong>家庭偏好</strong><p>偏好简短文字反馈；本计划可以显式覆盖。</p></section><details><summary>查看出门测与完整证据</summary><p>演示证据：3 个知识点，1 道错题已订正。</p></details></div>
            <div className={styles.editorColumn}><section><div><strong>教师最终正文</strong><span>批准与导出以这里为准</span></div><Textarea rows={10} value={draft} onChange={(event) => { setDraft(event.target.value); setSaved(false); }} /><footer><span>{saved ? "已保存" : "有未保存修改"}</span><Button uiSize="sm" onClick={() => setSaved(true)}>保存修改</Button></footer></section><div className={styles.itemActions}><Button variant="secondary">下一条需处理</Button><Button disabled={!saved} title={saved ? undefined : "请先保存修改"}>批准当前反馈</Button></div></div>
          </div>
        </section>
      </div>}
    </section>
  </main>;
}
