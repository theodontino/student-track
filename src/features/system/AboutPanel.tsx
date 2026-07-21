import Link from "next/link";
import { Badge, PageHeader, Section, StatusBanner } from "@/components/ui";
import packageMetadata from "../../../package.json";

export default function AboutPanel() {
  return <main className="system-about-workspace">
    <div className="system-about-hero">
      <span className="system-about-hero__mark" aria-hidden="true">CT</span>
      <PageHeader title="关于 Chem-Track AI" description="本地优先的化学教学记录、分析与家校反馈工作区。" actions={<Badge tone="info">v{packageMetadata.version}</Badge>} />
      <div className="system-about-highlights" aria-label="项目特性">
        <span>本机工作区</span><span>教师最终确认</span><span>AGPL-3.0-only</span>
      </div>
    </div>
    <div className="system-about-grid">
      <Section className="system-about-card" title="本机优先" description="核心学生数据保存在本机数据库中。" actions={<span aria-hidden="true">01</span>}><p>应用仅绑定 127.0.0.1，面向单教师工作区；备份、导出和外部模型的数据边界仍由操作者管理。</p></Section>
      <Section className="system-about-card" title="人机分工" description="模型提供草稿，确定性规则守住写入边界。" actions={<span aria-hidden="true">02</span>}><p>学生身份、课次、评分、考勤和正式写入不交给模型自行决定，生成内容需要教师复核。</p></Section>
      <Section className="system-about-card" title="可选集成" description="外部工具不属于 Chem-Track 发布物。" actions={<span aria-hidden="true">03</span>}><p>WeComCatch、FunASR 和云端模型按显式配置接入；未配置时不影响学生档案和课堂记录等核心能力。</p></Section>
    </div>
    <Section title="项目与数据边界" description="开源软件许可不等于公开教学数据。">
      <div className="system-about-copy">
        <StatusBanner tone="info">AGPL-3.0-only 适用于仓库中的软件和文档，不授权公开学生数据、运行数据库、录音、日志、导出文件或用户生成内容。</StatusBanner>
        <p>Copyright © 2026 theodontino。项目以 AGPL-3.0-only 发布，并保持 WeComCatch 等第三方工具在仓库之外。</p>
        <div className="system-about-links"><Link href="/system/license">查看完整许可文本</Link><a href="https://github.com/theodontino/studentdatabase" target="_blank" rel="noreferrer">打开源代码仓库</a></div>
      </div>
    </Section>
  </main>;
}
