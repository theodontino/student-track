"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, PageHeader, SegmentedControl } from "@/components/ui";
import styles from "./feedback-plan-reset-demo.module.css";

type EvidenceKey = "current" | "trend" | "teacherObservation" | "teacherAction" | "parentContext";
type Length = "short" | "standard" | "detailed";
type Tone = "natural" | "gentle" | "professional";

type EvidenceItem = {
  key: EvidenceKey;
  label: string;
  detail: string;
  risk: "low" | "medium" | "high";
  writerDefault: boolean;
};

const evidence: EvidenceItem[] = [
  { key: "current", label: "本课表现", detail: "出门测 8/10；电离平衡判断题基本正确，离子方程式两处条件遗漏。", risk: "low", writerDefault: true },
  { key: "trend", label: "趋势变化", detail: "最近两次同类题从 5/10 → 7/10 → 8/10，但条件识别错误仍重复出现。", risk: "low", writerDefault: true },
  { key: "teacherObservation", label: "教师发现", detail: "课堂追问时能说出原理，但遇到陌生条件会先套模板，说明迁移仍不稳定。", risk: "medium", writerDefault: true },
  { key: "teacherAction", label: "教师处理", detail: "课上已单独提醒先圈条件，再决定是否写离子方程式；课后准备继续追踪。", risk: "medium", writerDefault: false },
  { key: "parentContext", label: "家长历史", detail: "家长上周说反馈可以简短一点；前次也问过孩子是不是很多内容没听懂。", risk: "high", writerDefault: false },
];

function mockFeedback(enabled: Set<EvidenceKey>, length: Length, tone: Tone) {
  const parts = [tone === "professional" ? "今天这节课整体掌握得比较扎实。" : tone === "gentle" ? "今天整体跟得不错，前面的内容正在慢慢连起来。" : "今天这节课整体跟得挺稳。"];
  if (enabled.has("current")) parts.push("出门测做到了 8/10，电离平衡的主体判断已经比较稳，主要还卡在离子方程式的条件识别上。");
  if (enabled.has("trend")) parts.push("这类题最近几次其实在往上走，不过条件一变化还是容易沿用原来的写法，这个点还需要再压实。");
  if (enabled.has("teacherObservation")) parts.push("课堂追问时原理能说清楚，所以现在更像是陌生条件下的迁移还不够稳定，不是概念完全没理解。");
  if (enabled.has("teacherAction")) parts.push("今天课上已经带着他把“先圈条件、再决定写法”重新走了一遍，我后面会继续看这个习惯能不能稳定下来。");
  if (enabled.has("parentContext")) parts.push("您之前提到希望反馈尽量简短，也担心他是不是很多内容没听懂，所以这次我先把最关键的问题跟您说清楚。");
  if (length === "short") return parts.slice(0, 2).join("");
  if (length === "standard") return parts.slice(0, 4).join("");
  return parts.join("");
}

export function FeedbackPlanResetDemo() {
  const [enabled, setEnabled] = useState<Set<EvidenceKey>>(() => new Set(evidence.filter((item) => item.writerDefault).map((item) => item.key)));
  const [length, setLength] = useState<Length>("standard");
  const [tone, setTone] = useState<Tone>("natural");
  const [showRaw, setShowRaw] = useState(true);

  const allowed = useMemo(() => evidence.filter((item) => enabled.has(item.key)), [enabled]);
  const excluded = useMemo(() => evidence.filter((item) => !enabled.has(item.key)), [enabled]);
  const mainLine = enabled.has("teacherObservation")
    ? "主体知识已经掌握；当前问题更接近陌生条件下的迁移与条件识别，而不是概念完全不理解"
    : "主体知识已经掌握；当前主要问题是离子方程式条件识别仍不稳定";

  const writerPrompt = useMemo(() => [
    "你是一名高中化学教师。请根据下面已经筛选完成的反馈计划，写一条自然的微信反馈。",
    "",
    "本次目标：让家长知道本节掌握情况，只突出当前最值得关注的一条主线。",
    `核心主线：${mainLine}`,
    `可使用模块：${allowed.map((item) => item.label).join("、") || "无"}`,
    "",
    "允许使用的信息：",
    ...allowed.map((item) => `- [${item.label}] ${item.detail}`),
    "",
    `篇幅：${length === "short" ? "简短" : length === "detailed" ? "详细" : "标准"}`,
    `语气：${tone === "gentle" ? "温和" : tone === "professional" ? "专业" : "自然"}`,
    "",
    "禁止：",
    ...excluded.map((item) => `- 不要引用或暗示：${item.label}`),
    "- 不解释这些表达要求来自哪里。",
    "- 不补充计划里没有提供的历史、成绩、家长原话或教师内部处理。",
    "- 不写成编号报告，只返回最终文本。",
  ].join("\n"), [allowed, excluded, length, mainLine, tone]);

  function toggle(key: EvidenceKey) {
    setEnabled((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return <main className={styles.page}>
    <PageHeader
      title="Feedback Plan Reset · Demo"
      description="验证：先按计划裁剪上下文，再让一个模型直接成稿。这里不调用模型、不读取或写入真实数据。"
      actions={<div className={styles.headerActions}><Link href="/feedback/demo" className="ui-button ui-button--ghost ui-button--md">旧 Demo</Link><Link href="/feedback" className="ui-button ui-button--ghost ui-button--md">返回工作台</Link></div>}
    />

    <section className={styles.hero}>
      <div><Badge tone="info">Experimental</Badge><h2>Plan 决定“给什么”，Writer 只负责“怎么说”</h2><p>关闭一个模块，不是要求模型“看见但别说”，而是从 Writer 的上下文里直接移除。</p></div>
      <Button variant="secondary" onClick={() => setShowRaw((value) => !value)}>{showRaw ? "隐藏原始证据" : "查看原始证据"}</Button>
    </section>

    <section className={styles.flow} aria-label="生成链路"><strong>原始证据</strong><span>→</span><strong>Plan 过滤</strong><span>→</span><strong>Execution Brief</strong><span>→</span><strong>单模型成稿</strong><span>→</span><strong>教师复核</strong></section>

    <div className={styles.grid}>
      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><span className={styles.eyebrow}>01 · Plan</span><h3>本次允许 Writer 使用什么？</h3></div><Badge tone={excluded.length ? "warning" : "success"}>{allowed.length}/{evidence.length} 放行</Badge></div>
        <div className={styles.controlStack}>
          {evidence.map((item) => {
            const isEnabled = enabled.has(item.key);
            return <button key={item.key} type="button" className={`${styles.moduleRow} ${isEnabled ? styles.enabled : styles.disabled}`} onClick={() => toggle(item.key)}>
              <span className={styles.switch} aria-hidden="true"><i /></span>
              <span><strong>{item.label}</strong><small>{isEnabled ? "Writer 可以使用" : "Writer 完全看不到"}</small></span>
              <Badge tone={item.risk === "high" ? "warning" : item.risk === "medium" ? "info" : "success"}>{item.risk === "high" ? "高泄露风险" : item.risk === "medium" ? "内部语义" : "学生事实"}</Badge>
            </button>;
          })}
        </div>
        <div className={styles.options}>
          <label><span>篇幅</span><SegmentedControl label="篇幅" value={length} onChange={(value) => setLength(value as Length)} items={[{ value: "short", label: "简短" }, { value: "standard", label: "标准" }, { value: "detailed", label: "详细" }]} /></label>
          <label><span>语气</span><SegmentedControl label="语气" value={tone} onChange={(value) => setTone(value as Tone)} items={[{ value: "natural", label: "自然" }, { value: "gentle", label: "温和" }, { value: "professional", label: "专业" }]} /></label>
        </div>
        {showRaw && <div className={styles.rawEvidence}><strong>原始证据池（Plan 层可以看）</strong>{evidence.map((item) => <article key={item.key}><span>{item.label}</span><p>{item.detail}</p></article>)}</div>}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><span className={styles.eyebrow}>02 · Brief</span><h3>给 Writer 的执行说明</h3></div><Badge tone="success">已裁剪</Badge></div>
        <dl className={styles.brief}>
          <div><dt>目标</dt><dd>让家长知道本节掌握情况，只突出当前最值得关注的一条问题主线。</dd></div>
          <div><dt>核心主线</dt><dd>{mainLine}</dd></div>
          <div><dt>放行模块</dt><dd>{allowed.map((item) => item.label).join("、") || "没有模块"}</dd></div>
          <div><dt>明确排除</dt><dd>{excluded.length ? excluded.map((item) => item.label).join("、") : "无"}</dd></div>
        </dl>
        <details className={styles.promptPreview} open><summary>Writer 实际收到的 Prompt</summary><pre>{writerPrompt}</pre></details>
      </section>
    </div>

    <section className={styles.result}>
      <div className={styles.panelHeader}><div><span className={styles.eyebrow}>03 · Render</span><h3>模拟成稿</h3></div><Badge tone={enabled.has("parentContext") ? "warning" : "success"}>{enabled.has("parentContext") ? "家长历史已放行" : "家长历史不可见"}</Badge></div>
      <p>{mockFeedback(enabled, length, tone)}</p>
      {!enabled.has("parentContext") && <div className={styles.leakNote}>Writer 输入里没有“家长要求简短”的原话，因此无法生成“您之前提到希望反馈简短……”这种内容。</div>}
    </section>

    <footer className={styles.footerNote}><strong>这个 Demo 先验证上下文边界，不验证模型文笔。</strong><span>如果这个交互成立，正式实现只需要改生成上下文与单次成稿路径，不必重建 FeedbackPlan、数据库或三段式主工作流。</span></footer>
  </main>;
}
