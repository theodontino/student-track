import { expect, test } from "@playwright/test";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

test.describe.serial("v0.20.1 interaction polish", () => {
  test("dashboard exposes separate danger, apricot attention, and blue attendance glow surfaces", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-glow-tone="danger"]')).toBeVisible();
    await expect(page.locator('.dashboard-alerts [data-glow-tone="attention"]')).toBeVisible();
    await expect(page.locator('[data-glow-tone="attendance"]')).toBeVisible();
    const attention = page.locator('.dashboard-alerts [data-glow-tone="attention"]');
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

  test("feedback is the single entry workbench and links to the dedicated WeCom workspace", async ({ context, page }) => {
    await page.goto("/entry?step=input");
    await expect(page).toHaveURL(/\/feedback\?.*step=extract/);
    await expect(page.getByRole("heading", { name: "课后工作台" })).toBeVisible();
    await page.goto("/feedback?step=prepare");
    await expect(page.getByRole("link", { name: "前往企微家校" })).toHaveAttribute("href", "/wecom");
    await expect(page.getByText("WeComCatch 手动同步")).toHaveCount(0);

    const reviewPage = await context.newPage();
    await reviewPage.goto("/review");
    await expect(reviewPage).toHaveURL(/\/history\?view=drafts/);
    await expect(reviewPage.getByRole("heading", { name: "复核中心" })).toBeVisible();
    await reviewPage.close();
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

  test("AI generation history exposes controlled long-term generation and undo", async ({ page }) => {
    const actions: Array<Record<string, unknown>> = [];
    await page.route("**/api/teaching-memory*", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: {
          memories: [],
          history: [],
          drafts: [],
          classes: [{ id: TEST_FIXTURE.class.id, code: TEST_FIXTURE.class.code, name: TEST_FIXTURE.class.name }],
          undoableRuns: [{
            id: "test-compaction-run",
            classId: TEST_FIXTURE.class.id,
            className: TEST_FIXTURE.class.name,
            affectedCount: 2,
            completedAt: "2026-07-29T08:00:00.000Z",
            undoUntil: "2099-08-05T08:00:00.000Z",
          }],
        } });
        return;
      }
      actions.push(route.request().postDataJSON() as Record<string, unknown>);
      const action = actions.at(-1)?.action;
      await route.fulfill({ json: action === "long-term-drafts"
        ? { drafts: 0, skipped: true, reason: "no_reliable_semester_summary", runId: null, skippedScopes: 1 }
        : { success: true } });
    });

    await page.goto("/history?view=ai");
    await expect(page.getByRole("heading", { name: "长期背景草案" })).toBeVisible();
    await expect(page.getByText("确认后的内容仅在教师工作区展示，不进入家长反馈 prompt、预览或导出。")).toBeVisible();
    await expect(page.getByRole("button", { name: "撤销压缩" })).toBeVisible();
    await page.getByRole("button", { name: "生成到期长期背景草案" }).click();
    await expect(page.getByText("到期记录没有可用的受控学期摘要，已安全跳过且未调用模型。")).toBeVisible();
    expect(actions[0]).toEqual({ action: "long-term-drafts", classId: TEST_FIXTURE.class.id });

    await page.getByRole("button", { name: "撤销压缩" }).click();
    const dialog = page.getByRole("dialog", { name: "撤销学期快照压缩" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "撤销并恢复" }).click();
    await expect(page.getByText("学期快照压缩已撤销，窗口内的完整生成记录已恢复。")).toBeVisible();
    expect(actions[1]).toEqual({ action: "undo", runId: "test-compaction-run" });
  });

  test("third-party notice gates the handoff workspace and navigation entry", async ({ page }) => {
    await page.goto("/wecom");
    await expect(page.getByText("该工作区尚未在本机启用")).toBeVisible();
    await expect(page.getByRole("link", { name: "企微家校", exact: true })).toHaveCount(0);
    await expect(page.getByText("WeComCatch 手动同步")).toHaveCount(0);

    await page.getByRole("button", { name: "阅读第三方工具使用须知" }).click();
    const dialog = page.getByRole("dialog", { name: "第三方工具使用须知" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Student Track 只保存 handoff 台账、用于教师复核的草案、经确认的沟通摘要和最小诊断元数据；聊天原文仍由外部工具管理。")).toBeVisible();
    await expect(dialog.getByText("自动提取结果可能出错。系统先校验证据并唯一匹配学生，再生成待复核草案；教师选择实际课次并确认后，才会写入正式沟通。")).toBeVisible();
    const accept = dialog.getByRole("button", { name: "确认并启用入口" });
    await expect(accept).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await accept.click();

    await expect(page).toHaveURL(/\/wecom$/);
    await expect(page.getByRole("link", { name: "企微家校", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "接收与诊断" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "教师复核与入库" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: "企微家校", exact: true })).toBeVisible();
  });
});
