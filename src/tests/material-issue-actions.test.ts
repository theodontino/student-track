import { describe, expect, it } from "vitest";
import {
  materialBulkOperations,
  materialChoiceSelected,
  materialIssueActionTarget,
  materialIssueChoices,
  selectedMaterialIssueDecision,
} from "@/features/feedback/material-issue-actions";

describe("material issue actions", () => {
  it("generates one-item and bulk metadata from the same source/session policies", () => {
    expect(materialIssueChoices({ code: "assistant_class_mismatch", stage: "class" })).toEqual([
      expect.objectContaining({ action: "ignore_source", bulk: { key: "source:ignore", label: "全部忽略这些来源" } }),
    ]);
    expect(materialIssueChoices({ code: "assistant_date_mismatch", stage: "session" })).toEqual([
      expect.objectContaining({ action: "ignore_source", bulk: expect.objectContaining({ key: "source:ignore" }) }),
      expect.objectContaining({ action: "accept_source", bulk: expect.objectContaining({ key: "source:accept" }) }),
    ]);
  });

  it("covers attendance, observation and every structured score source", () => {
    expect(materialIssueChoices({ code: "attendance_conflict" }).map((choice) => choice.bulk?.key)).toEqual([
      "attendance:assistant",
      "attendance:step",
      "attendance:skip",
    ]);
    expect(materialIssueChoices({ code: "step_note_review" }).map((choice) => choice.bulk?.key)).toEqual([
      "observation:use-note",
      "observation:ignore-note",
    ]);
    const scoreChoices = materialIssueChoices({
      code: "score_conflict",
      scoreConflict: {
        studentId: "student-a",
        studentName: "甲同学",
        dimension: "A",
        candidates: [
          { id: "assistant", sourceKind: "assistant_roster", sourceName: "助教.xlsx", label: "助教表", score: 3 },
          { id: "step", sourceKind: "step_classroom", sourceName: "课堂.step", label: "STEP", score: 4 },
          { id: "pdf", sourceKind: "assessment_pdf", sourceName: "甲.pdf", label: "出门测", score: 4.2 },
          { id: "current", sourceKind: "current_metric", sourceName: "当前评分", label: "当前评分", score: 3 },
        ],
      },
    });
    expect(scoreChoices.map((choice) => choice.bulk?.key)).toEqual([
      "score:assistant_roster",
      "score:step_classroom",
      "score:assessment_pdf",
      undefined,
      "score:preserve",
    ]);
  });

  it("builds complete score and duplicate-PDF decisions", () => {
    const scoreIssue = {
      id: "score-1",
      runId: "run-1",
      sourceName: "汇总来源",
      code: "score_conflict",
      scoreConflict: {
        studentId: "student-a",
        studentName: "甲同学",
        dimension: "A" as const,
        candidates: [{ id: "pdf-a", sourceKind: "assessment_pdf" as const, sourceName: "甲.pdf", label: "出门测", score: 4.2 }],
      },
    };
    const scoreChoice = materialIssueChoices(scoreIssue)[0]!;
    expect(materialIssueActionTarget(scoreIssue, scoreChoice)).toEqual({
      kind: "decision",
      runId: "run-1",
      decision: { issueId: "score-1", action: "use_score_candidate", sourceName: "甲.pdf", candidateId: "pdf-a" },
    });

    const duplicateIssue = {
      id: "duplicate-1",
      runId: "run-1",
      code: "assessment_duplicate",
      assessmentDuplicate: {
        studentId: "student-a",
        studentName: "甲同学",
        candidates: [{ id: "source-a", sourceName: "甲-a.pdf", label: "甲-a.pdf", scoreA: 4.2 }],
      },
    };
    const duplicateChoice = materialIssueChoices(duplicateIssue)[0]!;
    expect(duplicateChoice.bulk).toBeUndefined();
    expect(materialIssueActionTarget(duplicateIssue, duplicateChoice)).toEqual({
      kind: "decision",
      runId: "run-1",
      decision: {
        issueId: "duplicate-1",
        action: "select_pdf",
        sourceName: "甲-a.pdf",
        sourceId: "source-a",
        candidateId: "source-a",
        studentId: "student-a",
      },
    });
    expect(materialChoiceSelected(
      { issueId: "duplicate-1", action: "select_pdf", candidateId: "source-a" },
      duplicateChoice,
    )).toBe(true);
  });

  it("does not batch identity or duplicate-PDF choices", () => {
    expect(materialIssueChoices({ code: "assessment_needs_match" })).toEqual([
      expect.objectContaining({ action: "skip_student" }),
    ]);
    const operations = materialBulkOperations([
      { id: "student-1", runId: "run-1", code: "student_mismatch", stage: "student" },
      { id: "student-2", runId: "run-1", code: "student_mismatch", stage: "student" },
      {
        id: "duplicate-1",
        runId: "run-1",
        code: "assessment_duplicate",
        assessmentDuplicate: {
          studentId: "student-a",
          studentName: "甲同学",
          candidates: [
            { id: "source-a", sourceName: "甲-a.pdf", label: "甲-a.pdf", scoreA: 4 },
            { id: "source-b", sourceName: "甲-b.pdf", label: "甲-b.pdf", scoreA: 4.2 },
          ],
        },
      },
    ]);
    expect(operations).toEqual([]);
  });

  it("does not batch an ambiguous score source with multiple candidates", () => {
    const issue = {
      id: "score-1",
      runId: "run-1",
      code: "score_conflict",
      scoreConflict: {
        studentId: "student-a",
        studentName: "甲同学",
        dimension: "A" as const,
        candidates: [
          { id: "pdf-a", sourceKind: "assessment_pdf" as const, sourceName: "甲-a.pdf", label: "出门测甲-a.pdf", score: 4.1 },
          { id: "pdf-b", sourceKind: "assessment_pdf" as const, sourceName: "甲-b.pdf", label: "出门测甲-b.pdf", score: 4.2 },
        ],
      },
    };

    expect(materialIssueChoices(issue).every((choice) => choice.bulk === undefined)).toBe(true);
    expect(materialBulkOperations([issue, issue])).toEqual([]);
  });

  it("groups safe policies and keeps unassigned-source dismissal out of run decisions", () => {
    const operations = materialBulkOperations([
      { id: "attendance-1", runId: "run-1", code: "attendance_conflict", sourceName: "一班.xlsx" },
      { id: "attendance-2", runId: "run-2", code: "attendance_conflict", sourceName: "二班.xlsx" },
      { unassignedSource: { fileName: "坏文件-a.pdf", kind: "assessment_pdf" } },
      { unassignedSource: { fileName: "坏文件-b.pdf", kind: "assessment_pdf" } },
    ]);
    expect(operations.map((operation) => [operation.key, operation.targets.length])).toEqual([
      ["attendance:assistant", 2],
      ["attendance:step", 2],
      ["attendance:skip", 2],
      ["source:ignore-unassigned", 2],
    ]);
    expect(operations.at(-1)?.targets).toEqual([
      { kind: "unassigned", source: { fileName: "坏文件-a.pdf", kind: "assessment_pdf" } },
      { kind: "unassigned", source: { fileName: "坏文件-b.pdf", kind: "assessment_pdf" } },
    ]);
  });

  it("matches source-wide choices by source id and never resolves a PDF duplicate by filename fallback", () => {
    const decisions = [{
      issueId: "date-a",
      action: "ignore_source" as const,
      sourceName: "同名.pdf",
      sourceId: "source-a",
    }];

    expect(selectedMaterialIssueDecision({
      id: "date-b",
      code: "assessment_date_mismatch",
      sourceName: "同名.pdf",
      sourceId: "source-a",
    }, decisions)).toEqual(decisions[0]);
    expect(selectedMaterialIssueDecision({
      id: "date-c",
      code: "assessment_date_mismatch",
      sourceName: "同名.pdf",
      sourceId: "source-b",
    }, decisions)).toBeUndefined();
    expect(selectedMaterialIssueDecision({
      id: "duplicate",
      code: "assessment_duplicate",
      sourceName: "同名.pdf",
      sourceId: "source-a",
    }, decisions)).toBeUndefined();
  });
});
