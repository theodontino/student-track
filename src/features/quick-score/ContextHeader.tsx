import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui";

export default function ContextHeader({ semesterName, sessionCount, history, children }: { semesterName?: string; sessionCount?: number; history: ReactNode; children: ReactNode }) {
  const contextDescription = semesterName ? `${semesterName} · 已记录 ${sessionCount ?? 0} 次课` : "选择学期、班级和课次后开始录入";

  return (
    <section className="quick-score-context">
      <PageHeader
        title="手动评分"
        description="录入三项评分与考勤；只保存本次修改的维度。"
        actions={history}
        context={<span className="quick-score-context__summary">{contextDescription}</span>}
      />
      <div className="quick-score-context__controls">{children}</div>
    </section>
  );
}
