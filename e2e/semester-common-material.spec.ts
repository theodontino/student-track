import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

function replacementWorkbook() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["E2E 替换候选"],
    ["课次", "课程主题", "群反馈", "统一测评说明", "全对的私反馈", "有错误的私反馈", "备注"],
    [1, "合成主题", "合成群反馈", "合成测评说明", "合成全对模板", "合成有误模板", ""],
  ]), "学期公共材料");
  return Buffer.from(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}

test("学期详情只有一个公共材料管理区，并在替换已有库前明确确认", async ({ page }) => {
  await page.goto(`/semesters/${TEST_FIXTURE.semester.id}#semester-common-materials`);
  const management = page.locator("#semester-common-materials");
  await expect(management).toHaveCount(1);
  await expect(management.getByRole("heading", { name: "学期公共材料" })).toBeVisible();
  await expect(management).toContainText("E2E 学期公共材料库");
  await expect(management).toContainText("已识别课次");
  await expect(management).toContainText("群反馈摘要");

  await management.locator('input[type="file"]').setInputFiles({
    name: "replacement.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: replacementWorkbook(),
  });
  const dialog = page.getByRole("dialog", { name: "整体替换学期公共材料" });
  await expect(dialog).toContainText("已有共同讲次不会自动覆盖");
  await expect(dialog.getByRole("button", { name: "确认整体替换" })).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
});
