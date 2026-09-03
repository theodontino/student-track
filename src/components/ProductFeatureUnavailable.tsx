import { PageHeader, StatusBanner } from "@/components/ui";

export default function ProductFeatureUnavailable({ featureName }: { featureName: string }) {
  return (
    <main className="system-about-workspace">
      <PageHeader
        title={`${featureName}不可用`}
        description="当前安装的是 Student Track Core 版。"
      />
      <StatusBanner tone="info">{featureName}仅在 Full 版中提供；Core 版的学生档案、课堂事实、反馈计划和已确认家校沟通仍可正常使用。</StatusBanner>
    </main>
  );
}
