import Link from "next/link";
import { Badge, PageHeader, Section, StatusBanner } from "@/components/ui";
import { PRODUCT_CHANGELOG } from "@/lib/product-changelog";
import { getProductCapabilities, getProductEdition, PRODUCT_EDITION_LABELS } from "@/lib/product-edition";
import packageMetadata from "../../../package.json";

export default function AboutPanel() {
  const edition = getProductEdition();
  const capabilities = getProductCapabilities();
  return <main className="system-about-workspace">
    <div className="system-about-hero">
      <span className="system-about-hero__mark" aria-hidden="true">ST</span>
      <PageHeader title="关于 Student Track" description="本地优先的化学教学记录、分析与家校反馈工作区。" actions={<><Badge tone="info">v{packageMetadata.version}</Badge><Badge tone="neutral">{PRODUCT_EDITION_LABELS[edition]} 版</Badge></>} />
      <div className="system-about-highlights" aria-label="项目特性">
        <span>本机工作区</span><span>教师最终确认</span><span>AGPL-3.0-only</span>
      </div>
    </div>
    <div className="system-about-grid">
      <Section className="system-about-card" title="本机优先" description="核心学生数据保存在本机数据库中。" actions={<span aria-hidden="true">01</span>}><p>应用仅绑定 127.0.0.1，面向单教师工作区；备份、导出和外部模型的数据边界仍由操作者管理。</p></Section>
      <Section className="system-about-card" title="人机分工" description="模型提供草稿，确定性规则守住写入边界。" actions={<span aria-hidden="true">02</span>}><p>学生身份、课次、评分、考勤和正式写入不交给模型自行决定，生成内容需要教师复核。</p></Section>
      <Section className="system-about-card" title={capabilities.audioTranscription ? "可选集成" : "Core 能力边界"} description={capabilities.audioTranscription ? "外部工具不属于 Student Track 发布物。" : "录音转写与企微家校仅在 Full 版提供。"} actions={<span aria-hidden="true">03</span>}>
        <p>{capabilities.audioTranscription
          ? "WeComCatch、FunASR 和云端模型按显式配置接入；未配置时不影响学生档案和课堂记录等核心能力。"
          : "Core 不探测、不启动也不调用 FunASR、通义听悟、阿里云 ASR 或 WCG；普通 LLM、学生档案和反馈工作流仍可使用。"}</p>
      </Section>
    </div>
    <Section title="版本更新" description="从 1.2 Beta 开始记录每个版本的用户可感知变化。">
      <div className="system-changelog">
        {PRODUCT_CHANGELOG.map((entry, index) => <article key={entry.version} className="system-changelog__entry">
          <header><div><Badge tone={index === 0 ? "info" : "neutral"}>v{entry.version}</Badge>{index === 0 && <span>当前版本</span>}</div><strong>{entry.title}</strong></header>
          <ul>{entry.changes.map((change) => <li key={change}>{change}</li>)}</ul>
        </article>)}
      </div>
    </Section>
    <Section title="项目与数据边界" description="开源软件许可不等于公开教学数据。">
      <div className="system-about-copy">
        <StatusBanner tone="info">AGPL-3.0-only 适用于仓库中的软件和文档，不授权公开学生数据、运行数据库、录音、日志、导出文件或用户生成内容。</StatusBanner>
        <p>Copyright © 2026 theodontino。项目以 AGPL-3.0-only 发布，并保持 WeComCatch 等第三方工具在仓库之外。</p>
        <div className="system-about-links"><Link href="/system/license">查看完整许可文本</Link><a href="https://github.com/theodontino/student-track" target="_blank" rel="noreferrer">打开源代码仓库</a></div>
      </div>
    </Section>
  </main>;
}
