import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StudentImportDialog } from "@/features/students/StudentImportDialog";
import type { useStudentsWorkspace } from "@/features/students/useStudentsWorkspace";

describe("student import dialog", () => {
  it("offers one obvious local-only file picker with format guidance", () => {
    const workspace = {
      showImportDialog: true,
      closeImport: () => undefined,
      selectedSemesterId: "semester-test",
      importing: false,
      importFile: null,
      selectImportFile: () => Promise.resolve(),
      importAnalysis: null,
      importSubject: "",
      importTeacher: "",
      importSearch: "",
      setImportSubject: () => undefined,
      setImportTeacher: () => undefined,
      setImportSearch: () => undefined,
      availableImportTeachers: [],
      visibleImportClasses: [],
      selectedImportClassCodes: new Set<string>(),
      toggleImportClass: () => undefined,
      importResult: null,
      importStudents: () => Promise.resolve(),
    } as unknown as ReturnType<typeof useStudentsWorkspace>;

    const markup = renderToStaticMarkup(<StudentImportDialog workspace={workspace} />);
    expect(markup).toContain("选择或拖入花名册文件");
    expect(markup).toContain("支持 .xlsx、.csv；一次仅分析一个文件");
    expect(markup).toContain("选择文件后立即开始分析");
    expect(markup).toContain('aria-label="花名册文件"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('for="student-import-file"');
  });

  it("shows row-level blocking details returned by the preview", () => {
    const workspace = {
      showImportDialog: true,
      closeImport: () => undefined,
      selectedSemesterId: "semester-test",
      importing: false,
      importFile: new File(["synthetic"], "synthetic.csv", { type: "text/csv" }),
      selectImportFile: () => Promise.resolve(),
      importAnalysis: { rowCount: 2, classes: [], subjects: [] },
      importSubject: "",
      importTeacher: "",
      importSearch: "",
      setImportSubject: () => undefined,
      setImportTeacher: () => undefined,
      setImportSearch: () => undefined,
      availableImportTeachers: [],
      visibleImportClasses: [],
      selectedImportClassCodes: new Set<string>(),
      toggleImportClass: () => undefined,
      importResult: {
        mode: "preview" as const,
        blocked: true,
        error: "预览存在阻断项，请按明细修正后重试",
        errors: ["第 3 行：学生 TEST-001 在文件中出现多个班级"],
      },
      importStudents: () => Promise.resolve(),
    } as unknown as ReturnType<typeof useStudentsWorkspace>;

    const markup = renderToStaticMarkup(<StudentImportDialog workspace={workspace} />);
    expect(markup).toContain("预览存在阻断项");
    expect(markup).toContain("第 3 行：学生 TEST-001 在文件中出现多个班级");
  });
});
