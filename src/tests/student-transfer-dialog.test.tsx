import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StudentTransferDialog } from "@/features/students/StudentTransferDialog";
import type { useStudentsWorkspace } from "@/features/students/useStudentsWorkspace";

function workspace(phase: "loading" | "ready" | "error", items = [{ id: "other-class", code: "TEST-02", name: "合成转入班", semesterId: "semester-test" }]) {
  return {
    transferTarget: { id: "student-test", name: "合成学生", class: "合成原班", classId: "current-class" },
    semesterClasses: items,
    classOptions: { items, phase, error: "暂时无法读取班级", diagnosticId: "diag-test", retry: () => undefined },
    closeTransfer: () => undefined,
    submitTransfer: () => Promise.resolve(),
    transferError: "",
    transferClassId: "",
    setTransferClassId: () => undefined,
    transferring: false,
  } as unknown as ReturnType<typeof useStudentsWorkspace>;
}

describe("student transfer dialog class options", () => {
  it("keeps the native select disabled while class options are loading", () => {
    const markup = renderToStaticMarkup(<StudentTransferDialog workspace={workspace("loading")} />);
    expect(markup).toContain("正在加载当前学期的班级列表");
    expect(markup).toContain('aria-label="目标班级"');
    expect(markup).toContain("disabled");
  });

  it("shows an actionable diagnostic and retry without closing the dialog after a failed load", () => {
    const markup = renderToStaticMarkup(<StudentTransferDialog workspace={workspace("error")} />);
    expect(markup).toContain("班级列表加载失败：暂时无法读取班级");
    expect(markup).toContain("诊断编号：diag-test");
    expect(markup).toContain("重试");
    expect(markup).toContain("转班：合成学生");
  });

  it("only calls out the empty state after a successful class-list response", () => {
    const markup = renderToStaticMarkup(<StudentTransferDialog workspace={workspace("ready", [{ id: "current-class", code: "TEST-01", name: "合成原班", semesterId: "semester-test" }])} />);
    expect(markup).toContain("当前学期没有可选的其他班级");
    expect(markup).toContain("确认转班");
  });
});
