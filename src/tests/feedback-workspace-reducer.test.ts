import { describe, expect, it } from "vitest";
import {
  createFeedbackWorkspaceCoreState,
  feedbackWorkspaceCoreReducer,
} from "@/features/feedback/feedback-workspace-reducer";
import type { DraftStructuredResult } from "@/lib/types";

describe("feedback workspace reducer", () => {
  it("keeps workflow changes explicit and bounded", () => {
    let core = createFeedbackWorkspaceCoreState();
    core = feedbackWorkspaceCoreReducer(core, { type: "patch", patch: { rawText: "课堂记录" } });
    core = feedbackWorkspaceCoreReducer(core, { type: "stream/append", content: "片段一" });
    core = feedbackWorkspaceCoreReducer(core, { type: "stream/append", content: "片段二" });
    expect(core.rawText).toBe("课堂记录");
    expect(core.streamContent).toBe("片段一片段二");

  });

  it("keeps teacher observation edits in reducer state until confirmation", () => {
    const parsedResult: DraftStructuredResult = {
      students: [{ name: "甲", scores: { A: null, B: null, C: null }, events: [], communication: null }],
      alert_suggestion: "",
    };
    const core = feedbackWorkspaceCoreReducer(
      { ...createFeedbackWorkspaceCoreState(), parsedResult, confirmed: true },
      {
        type: "parsed/teacher-interventions",
        index: 0,
        interventions: [{ observedProblem: "审题时漏看条件", teacherAction: "", outcome: "", evidenceText: "" }],
      },
    );

    expect(core.parsedResult?.students[0].teacherInterventions).toEqual([
      { observedProblem: "审题时漏看条件", teacherAction: "", outcome: "", evidenceText: "" },
    ]);
    expect(core.confirmed).toBe(false);
    expect(core.status).toContain("重新确认写入");
  });
});
