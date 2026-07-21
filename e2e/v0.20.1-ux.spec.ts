import { expect, test } from "@playwright/test";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

test.describe.serial("v0.20.1 interaction polish", () => {
  test("dashboard exposes separate danger, apricot attention, and blue attendance glow surfaces", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-glow-tone="danger"]')).toBeVisible();
    await expect(page.locator('[data-glow-tone="attention"]')).toBeVisible();
    await expect(page.locator('[data-glow-tone="attendance"]')).toBeVisible();
    const attention = page.locator('[data-glow-tone="attention"]');
    await attention.hover({ position: { x: 4, y: 4 } });
    await expect.poll(() => attention.evaluate((element) => (element as HTMLElement).style.getPropertyValue("--glow-border-strength"))).not.toBe("18%");
  });

  test("student preview waits, enters, reverses out, and row click opens the full profile", async ({ page }) => {
    await page.goto(`/students?semesterId=${TEST_FIXTURE.semester.id}`);
    const row = page.getByRole("button", { name: `打开${TEST_FIXTURE.students[0].name}的学生档案` });
    await row.hover();
    await expect(page.getByLabel(`${TEST_FIXTURE.students[0].name}档案预览`)).toHaveCount(0);
    await page.waitForTimeout(140);
    const preview = page.getByLabel(`${TEST_FIXTURE.students[0].name}档案预览`);
    await expect(preview).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(preview).toHaveClass(/is-exiting/, { timeout: 500 });
    await expect(preview).toHaveCount(0, { timeout: 700 });
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/students/${TEST_FIXTURE.students[0].id}\\?semesterId=${TEST_FIXTURE.semester.id}`));
  });

  test("feedback is the single entry workbench and links to the dedicated WeCom workspace", async ({ page }) => {
    await page.goto("/entry?step=input");
    await expect(page).toHaveURL(/\/feedback\?.*step=extract/);
    await expect(page.getByRole("heading", { name: "课后工作台" })).toBeVisible();
    await page.getByRole("button", { name: "1 准备 选择课次与准备材料" }).click();
    await expect(page.getByRole("link", { name: "前往企微家校" })).toHaveAttribute("href", "/wecom");
    await expect(page.getByText("WeComCatch 手动同步")).toHaveCount(0);

    await page.goto("/review");
    await expect(page).toHaveURL(/\/history\?view=drafts/);
    await expect(page.getByRole("heading", { name: "复核中心" })).toBeVisible();
  });

  test("local tool checks use compact expandable cards", async ({ page }) => {
    await page.route("**/api/system/local-tools", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        checkedAt: "2026-07-16T00:00:00.000Z",
        tools: [{ id: "funasr", name: "音频转写 / FunASR", status: "available", summary: "静态检查通过", checks: [{ id: "entry", label: "项目转写入口", status: "available", detail: "入口可执行", path: "/tmp/funasr/diarize.sh" }] }],
      }),
    }));
    await page.goto("/system/integrations");
    await expect(page.getByRole("heading", { name: "本地工具状态" })).toBeVisible();
    await expect(page.getByText("/tmp/funasr/diarize.sh")).toHaveCount(0);
    await page.getByRole("button", { name: "查看 1 项检查详情" }).click();
    await expect(page.getByText("/tmp/funasr/diarize.sh")).toBeVisible();
    await expect(page.locator("#wecom-access")).toBeVisible();
    await expect(page.getByRole("heading", { name: "企微家校工作区" })).toBeVisible();
    await expect(page.getByText("WeComCatch 手动同步")).toHaveCount(0);
  });

  test("third-party notice gates the standalone WeCom workspace and navigation entry", async ({ page }) => {
    await page.goto("/wecom");
    await expect(page.getByText("该工作区尚未在本机启用")).toBeVisible();
    await expect(page.getByRole("link", { name: "企微家校", exact: true })).toHaveCount(0);
    await expect(page.getByText("WeComCatch 手动同步")).toHaveCount(0);

    await page.getByRole("button", { name: "阅读第三方工具使用须知" }).click();
    const dialog = page.getByRole("dialog", { name: "第三方工具使用须知" });
    await expect(dialog).toBeVisible();
    const accept = dialog.getByRole("button", { name: "确认并启用入口" });
    await expect(accept).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await accept.click();

    await expect(page).toHaveURL(/\/wecom$/);
    await expect(page.getByRole("link", { name: "企微家校", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "同步与导入" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "复核与回滚" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: "企微家校", exact: true })).toBeVisible();
  });
});
