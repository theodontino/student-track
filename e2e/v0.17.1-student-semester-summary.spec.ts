import { expect, test } from "@playwright/test";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

test.describe.serial("v0.17.1 student semester summaries", () => {
  test("list and detail share the selected semester and show derived scores", async ({ page }) => {
    const historicalResponse = await page.request.post("/api/semesters", {
      data: { name: "E2E空白往期", startDate: "2025-01-01", endDate: "2025-06-30" },
    });
    expect(historicalResponse.ok()).toBe(true);
    const historicalSemester = await historicalResponse.json() as { id: string };

    await page.goto(`/students?semesterId=${TEST_FIXTURE.semester.id}`);
    await expect(page.getByRole("heading", { name: "学生档案" })).toBeVisible();
    await expect(page.getByLabel("查看学期")).toHaveValue(TEST_FIXTURE.semester.id);
    const stableScore = page.getByTestId(`student-semester-score-${TEST_FIXTURE.students[1].id}`);
    await expect(stableScore).toContainText("本学期综合分");
    await expect(stableScore).toContainText("70");
    await expect(stableScore).toContainText("评价 1 次 · 考勤 2 次");

    await page.getByText(TEST_FIXTURE.students[0].name, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/students/${TEST_FIXTURE.students[0].id}\\?semesterId=${TEST_FIXTURE.semester.id}`));
    await expect(page.getByTestId("student-semester-radar")).toContainText("本学期四维平均表现");
    await expect(page.getByTestId("student-semester-summary")).toContainText("/100");
    await expect(page.getByText("氧化还原反应测验完成稳定", { exact: true })).toBeVisible();

    await page.getByLabel("查看学期").selectOption(historicalSemester.id);
    await expect(page).toHaveURL(new RegExp(`semesterId=${historicalSemester.id}`));
    await expect(page.getByTestId("student-semester-summary")).toContainText("本学期暂无课次评价和考勤记录");
    await expect(page.getByText("本学期暂无课次评价", { exact: true })).toBeVisible();
    await expect(page.getByText("暂无事件", { exact: true })).toBeVisible();
    const communicationCard = page.getByTestId("student-records-view-communications").locator("../..");
    await expect(communicationCard.getByText("暂无记录", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "← 返回学生列表" }).click();
    await expect(page.getByLabel("查看学期")).toHaveValue(historicalSemester.id);
    await expect(page.getByTestId(`student-semester-score-${TEST_FIXTURE.students[1].id}`)).toContainText("—");
    await page.reload();
    await expect(page.getByLabel("查看学期")).toHaveValue(historicalSemester.id);
  });
});
