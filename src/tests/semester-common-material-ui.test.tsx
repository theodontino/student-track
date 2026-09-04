import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskPreparationStage } from "@/features/feedback/TaskPreparationStage";
import { createFeedbackTaskDraft, type FeedbackTaskClassDraft } from "@/features/feedback/feedback-task-state";

const entry: FeedbackTaskClassDraft = {
  classId: "class-one",
  classCode: "ONE",
  className: "合成班级",
  sessionCode: "session-one",
  runId: "",
  studentIds: [],
  studentSelectionInitialized: true,
  selected: true,
};

describe("semester common material navigation", () => {
  it("links an empty preparation state directly to the semester management anchor", () => {
    const markup = renderToStaticMarkup(<TaskPreparationStage
      draft={{ ...createFeedbackTaskDraft(), entries: [entry], activeSessionCode: entry.sessionCode }}
      entry={entry}
      run={null}
      studentTotal={0}
      busy={false}
      commonMaterialLabel="当前课次没有公共材料"
      commonMaterialPreview=""
      commonMaterialOptions={[{ value: "none", label: "本次不使用公共材料" }]}
      commonMaterialChoice="none"
      commonMaterialAction="session"
      commonMaterialHelp=""
      manualFactsHref="/feedback/tools?tool=manual-facts"
      semesterMaterialsHref="/semesters/semester%2Fone#semester-common-materials"
      onFiles={() => undefined}
      onScan={() => undefined}
      onUseExistingFacts={() => undefined}
      onCommonMaterialChoice={() => undefined}
      onSaveSessionMaterial={async () => undefined}
      onContinue={() => undefined}
    />);
    expect(markup).toContain('href="/semesters/semester%2Fone#semester-common-materials"');
    expect(markup).not.toContain("/feedback/tools?tool=materials");
    expect(markup).toContain("自定义本课背景");
    expect(markup).toContain("本课课程背景（可选）");
  });
});
