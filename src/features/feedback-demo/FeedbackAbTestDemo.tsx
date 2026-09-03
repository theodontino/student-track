"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Card, PageHeader, Select, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import type {
  BlindAssignment,
  ContentBrief,
  FeedbackAbTestAdherence,
  FeedbackAbTestCandidatePlan,
  FeedbackAbTestModification,
  FeedbackAbTestOverall,
  FeedbackAbTestResult,
  FeedbackAbTestScores,
  FeedbackAbTestStoredResult,
  ModelIdentity,
  TokenUsage,
} from "@/services/feedback-ab-test-service";
import {
  approachForBlindSide,
  BLIND_SIDE_LABELS,
  formatDuration,
  formatTokenValue,
  isRatingComplete,
  outputForBlindSide,
  type BlindSide,
} from "./feedback-ab-test-ui";
import styles from "./feedback-ab-test-demo.module.css";

const STORAGE_KEY = "student-track:feedback-ab-test:v1";

const overallOptions: Array<{ value: FeedbackAbTestOverall; label: string }> = [
  { value: "a_much_better", label: "A 明显好" },
  { value: "a_bit_better", label: "A 稍好" },
  { value: "tie", label: "差不多" },
  { value: "b_bit_better", label: "B 稍好" },
  { value: "b_much_better", label: "B 明显好" },
];
const modificationOptions: Array<{ value: FeedbackAbTestModification; label: string }> = [
  { value: "direct", label: "直接可发" },
  { value: "small_edit", label: "小改" },
  { value: "content_edit", label: "内容需要修改" },
  { value: "rewrite", label: "基本重写" },
];
const adherenceOptions: Array<{ value: FeedbackAbTestAdherence; label: string }> = [
  { value: "full", label: "完全遵守" },
  { value: "slight_deviation", label: "轻微偏离" },
  { value: "overreach", label: "明显越权" },
];

type ScoresDraft = {
  overall: FeedbackAbTestOverall | "";
  a: { modification: FeedbackAbTestModification | ""; adherence: FeedbackAbTestAdherence | ""; aiFlavor: number };
  b: { modification: FeedbackAbTestModification | ""; adherence: FeedbackAbTestAdherence | ""; aiFlavor: number };
};

function emptyScores(): ScoresDraft {
  return {
    overall: "",
    a: { modification: "", adherence: "", aiFlavor: 0 },
    b: { modification: "", adherence: "", aiFlavor: 0 },
  };
}

function readStoredResults() {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value as FeedbackAbTestStoredResult[] : [];
  } catch {
    return [];
  }
}

function approachLabel(value: "current" | "planner_writer") {
  return value === "current" ? "Current" : "Planner → Writer";
}

function modelLabel(identity: ModelIdentity) {
  return `${identity.model} · profile ${identity.profileId ?? "环境配置"}`;
}

function tokenRow(label: string, usage: TokenUsage | null) {
  return (
    <div className={styles.metricRow}>
      <span>{label}</span>
      <span>
        输入 {formatTokenValue(usage?.inputTokens)} · 输出 {formatTokenValue(usage?.outputTokens)} · 推理 {formatTokenValue(usage?.reasoningTokens)} · 总计 {formatTokenValue(usage?.totalTokens)}
      </span>
    </div>
  );
}

function OutputCard({ side, text }: { side: BlindSide; text: string }) {
  return (
    <Card className={styles.outputCard}>
      <div className={styles.outputLabel}><span>{BLIND_SIDE_LABELS[side]}</span><span className={styles.blindPill}>盲测中</span></div>
      <p>{text || "本轮文本未通过少量技术检查"}</p>
    </Card>
  );
}

export function FeedbackAbTestDemo() {
  const [plans, setPlans] = useState<FeedbackAbTestCandidatePlan[]>([]);
  const [planId, setPlanId] = useState("");
  const [planItemId, setPlanItemId] = useState("");
  const [result, setResult] = useState<FeedbackAbTestResult | null>(null);
  const [scores, setScores] = useState<ScoresDraft>(emptyScores);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [storedCount, setStoredCount] = useState(0);

  useEffect(() => {
    setStoredCount(readStoredResults().length);
    void requestJson<{ plans: FeedbackAbTestCandidatePlan[] }>("/api/feedback/demo/ab-test")
      .then((response) => setPlans(response.plans))
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "读取实验候选失败"))
      .finally(() => setLoading(false));
  }, []);

  const selectedPlan = useMemo(() => plans.find((plan) => plan.planId === planId) ?? null, [plans, planId]);
  const selectedItem = selectedPlan?.items.find((item) => item.planItemId === planItemId) ?? null;

  useEffect(() => {
    if (selectedPlan && !selectedPlan.items.some((item) => item.planItemId === planItemId)) {
      setPlanItemId(selectedPlan.items[0]?.planItemId ?? "");
    }
  }, [selectedPlan, planItemId]);

  function resetResult() {
    setResult(null);
    setSubmitted(false);
    setScores(emptyScores());
    setNotice("");
  }

  function handlePlanChange(value: string) {
    setPlanId(value);
    setPlanItemId("");
    resetResult();
  }

  async function runExperiment() {
    if (!planId || !planItemId) return;
    setRunning(true);
    setError("");
    setNotice("");
    resetResult();
    try {
      const response = await requestJson<FeedbackAbTestResult>("/api/feedback/demo/ab-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, planItemId }),
      });
      setResult(response);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : "实验运行失败");
    } finally {
      setRunning(false);
    }
  }

  function updateScore(side: "a" | "b", field: "modification" | "adherence" | "aiFlavor", value: string) {
    setScores((current) => ({ ...current, [side]: { ...current[side], [field]: field === "aiFlavor" ? Number(value) : value } }));
  }

  function submitRating() {
    if (!result) return;
    const normalized = scores as FeedbackAbTestScores;
    if (!isRatingComplete(normalized)) return;
    const record: FeedbackAbTestStoredResult = {
      version: 1,
      planId: result.planId,
      planItemId: result.planItemId,
      timestamp: new Date().toISOString(),
      generatedAt: result.generatedAt,
      blindAssignment: result.assignment,
      outputs: { A: outputForBlindSide(result, "A"), B: outputForBlindSide(result, "B") },
      plannerBrief: result.plannerBrief,
      scores: normalized,
      actualApproach: { A: approachForBlindSide(result, "A"), B: approachForBlindSide(result, "B") },
      latency: result.latency,
      tokenUsage: result.tokenUsage,
      models: result.models,
    };
    try {
      const records = [...readStoredResults(), record];
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
      setStoredCount(records.length);
      setNotice("评分已保存到本浏览器");
    } catch {
      setNotice("浏览器无法写入 localStorage；本轮仍可查看，但未保存评分");
    }
    setSubmitted(true);
  }

  function exportResults() {
    const records = readStoredResults();
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records }, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "feedback-ab-test-results.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <main className={styles.page}>
      <PageHeader
        title="反馈生成 A/B 实验"
        description="在同一份已冻结的 FeedbackPlanItem 证据上，盲测 Current 与 Planner → Writer。实验只读，评分只保存在本浏览器。"
        actions={<Button variant="secondary" onClick={exportResults}>导出实验结果 JSON</Button>}
      />

      <section className={styles.hero}>
        <div><span className={styles.kicker}>Development experiment · beta.2</span><h2>同一份事实，哪一条生成链更愿意直接发送？</h2><p>先选一个已经存在的学生反馈条目。两组使用同一份冻结 evidenceSnapshot、计划要求、学生身份与参考日期，不会写回反馈计划。</p></div>
        <div className={styles.heroStamp}><strong>{storedCount}</strong><span>浏览器已保存评分</span></div>
      </section>

      {error && <StatusBanner tone="danger">{error}</StatusBanner>}
      {notice && <StatusBanner tone="success">{notice}</StatusBanner>}

      <Card className={styles.selectorCard}>
        <div className={styles.sectionHeading}><div><span className={styles.kicker}>01 · Frozen input</span><h2>选择真实 FeedbackPlanItem</h2></div><span className={styles.readOnlyTag}>只读读取</span></div>
        <div className={styles.selectorGrid}>
          <label>反馈计划<Select value={planId} onChange={(event) => handlePlanChange(event.target.value)} disabled={loading || running}><option value="">{loading ? "读取计划中…" : "请选择反馈计划"}</option>{plans.map((plan) => <option key={plan.planId} value={plan.planId}>{plan.displayName} · {plan.type}</option>)}</Select></label>
          <label>学生条目<Select value={planItemId} onChange={(event) => { setPlanItemId(event.target.value); resetResult(); }} disabled={!selectedPlan || running}><option value="">请选择学生条目</option>{selectedPlan?.items.map((item) => <option key={item.planItemId} value={item.planItemId}>{item.studentName}{item.studentNumber ? ` · ${item.studentNumber}` : ""}</option>)}</Select></label>
        </div>
        {selectedItem && <p className={styles.selectionNote}>已选择「{selectedItem.studentName}」。计划和条目的正式正文、审核、批准、导出状态都不会被本实验触碰。</p>}
        <div className={styles.actionRow}><span>建议连续完成约 15 个真实条目的盲测，再比较整体偏好。</span><Button onClick={() => void runExperiment()} disabled={!selectedPlan || !selectedItem || running}>{running ? "两条路径生成中…" : "生成一轮 A/B"}</Button></div>
      </Card>

      {result && !submitted && <section className={styles.experimentSection} aria-label="盲测反馈">
        <div className={styles.sectionHeading}><div><span className={styles.kicker}>02 · Blind review</span><h2>先只看方案文本</h2></div><span className={styles.blindPill}>身份已隐藏</span></div>
        <div className={styles.outputGrid}><OutputCard side="A" text={outputForBlindSide(result, "A")} /><OutputCard side="B" text={outputForBlindSide(result, "B")} /></div>
        <Card className={styles.ratingCard}><h3>总体偏好</h3><div className={styles.radioGrid}>{overallOptions.map((option) => <label key={option.value}><input type="radio" name="overall" checked={scores.overall === option.value} onChange={() => setScores((current) => ({ ...current, overall: option.value }))} />{option.label}</label>)}</div><div className={styles.sideRatings}><RatingFields side="a" title="方案 A" scores={scores.a} onChange={updateScore} /><RatingFields side="b" title="方案 B" scores={scores.b} onChange={updateScore} /></div><div className={styles.actionRow}><span>评分提交后才会揭示方案身份、brief、耗时与模型信息。</span><Button onClick={submitRating} disabled={!isRatingComplete(scores as FeedbackAbTestScores)}>提交评分并揭示</Button></div></Card>
      </section>}

      {result && submitted && <Reveal result={result} />}
    </main>
  );
}

function RatingFields({ side, title, scores, onChange }: { side: "a" | "b"; title: string; scores: ScoresDraft["a"]; onChange: (side: "a" | "b", field: "modification" | "adherence" | "aiFlavor", value: string) => void }) {
  return <div className={styles.ratingFields}><h3>{title}</h3><label>修改程度<Select value={scores.modification} onChange={(event) => onChange(side, "modification", event.target.value)}><option value="">请选择</option>{modificationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label><label>计划依从<Select value={scores.adherence} onChange={(event) => onChange(side, "adherence", event.target.value)}><option value="">请选择</option>{adherenceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label><label>AI 味（1–5）<Select value={scores.aiFlavor || ""} onChange={(event) => onChange(side, "aiFlavor", event.target.value)}><option value="">请选择</option>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</Select></label></div>;
}

function Reveal({ result }: { result: FeedbackAbTestResult }) {
  return <section className={styles.revealSection}><div className={styles.sectionHeading}><div><span className={styles.kicker}>03 · Revealed</span><h2>本轮结果已揭示</h2></div><span className={styles.readOnlyTag}>未写入业务数据</span></div><div className={styles.revealGrid}><div><p>方案 A：<strong>{approachLabel(approachForBlindSide(result, "A"))}</strong></p><p>方案 B：<strong>{approachLabel(approachForBlindSide(result, "B"))}</strong></p></div><div><p>学生：{result.studentName}</p><p>Current：{formatDuration(result.latency.current.totalMs)}</p><p>Planner → Writer：{formatDuration(result.latency.plannerWriter.totalMs)}</p></div></div><div className={styles.outputGrid}><OutputCard side="A" text={outputForBlindSide(result, "A")} /><OutputCard side="B" text={outputForBlindSide(result, "B")} /></div><details className={styles.details}><summary>查看 Planner ContentBrief</summary><pre>{JSON.stringify(result.plannerBrief, null, 2)}</pre></details><div className={styles.metricsGrid}><Card><h3>耗时</h3><div className={styles.metricRow}><span>Current · generateFeedbackPlanComposition</span><strong>{formatDuration(result.latency.current.stages.generationMs)}</strong></div><div className={styles.metricRow}><span>Planner</span><strong>{formatDuration(result.latency.plannerWriter.stages.plannerMs)}</strong></div><div className={styles.metricRow}><span>Writer</span><strong>{formatDuration(result.latency.plannerWriter.stages.writerMs)}</strong></div></Card><Card><h3>Token usage</h3>{tokenRow("Current", result.tokenUsage.current)}{tokenRow("Planner", result.tokenUsage.planner)}{tokenRow("Writer", result.tokenUsage.writer)}{tokenRow("Planner → Writer", result.tokenUsage.plannerWriter)}</Card></div><Card><h3>实际模型 / profile</h3><div className={styles.metricRow}><span>Current · draft</span><span>{modelLabel(result.models.current.draft)}</span></div><div className={styles.metricRow}><span>Current · review</span><span>{modelLabel(result.models.current.review)}</span></div><div className={styles.metricRow}><span>Planner</span><span>{modelLabel(result.models.planner)}</span></div><div className={styles.metricRow}><span>Writer</span><span>{modelLabel(result.models.writer)}</span></div></Card></section>;
}
