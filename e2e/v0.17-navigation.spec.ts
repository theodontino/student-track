import { expect, test } from "@playwright/test";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

test.describe.serial("v0.17.0 information architecture", () => {
  test("dashboard persists the selected semester in the URL", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible();
    await page.getByLabel("查看学期").selectOption(TEST_FIXTURE.semester.id);
    await expect(page).toHaveURL(new RegExp(`semesterId=${TEST_FIXTURE.semester.id}`));
    await expect(page.getByText(`${TEST_FIXTURE.semester.name} · 学期概览与风险提示`)).toBeVisible();
  });

  test("legacy routes open their v0.17 workspaces", async ({ page }) => {
    await page.goto("/input");
    await expect(page).toHaveURL(/\/entry\?step=input/);
    await expect(page.getByRole("heading", { name: "课堂录入" })).toBeVisible();

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/system\/configuration/);
    await expect(page.getByRole("heading", { name: "系统中心" })).toBeVisible();

    await page.goto("/report");
    await expect(page).toHaveURL(/\/daily-report/);
    await expect(page.getByRole("heading", { name: "班级日报" })).toBeVisible();
  });

  test("daily report uses the shared teaching context", async ({ page }) => {
    await page.route("**/api/report/daily", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ report: "E2E 班级日报：课堂状态稳定。" }) }));
    await page.goto("/daily-report");
    await page.getByLabel("学期").selectOption(TEST_FIXTURE.semester.id);
    await page.getByLabel("班级").selectOption({ label: TEST_FIXTURE.class.name });
    await page.getByLabel("课次").selectOption(TEST_FIXTURE.sessions[0].code);
    await page.getByRole("button", { name: "生成班级日报" }).click();
    await expect(page.getByText("E2E 班级日报：课堂状态稳定。")).toBeVisible();
  });

  test("narrow windows use the accessible navigation drawer", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "打开导航" }).click();
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
    await page.getByRole("link", { name: "系统中心" }).click();
    await expect(page).toHaveURL(/\/system\/configuration/);
    await expect(page.getByRole("heading", { name: "系统中心" })).toBeVisible();
  });
});
