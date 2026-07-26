import { expect, test } from "@playwright/test";

test("local WCC relay exposes scan, alignment and review handoff without the WCC API", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("student-track:wecom-access", JSON.stringify({
    version: "wecom-third-party-notice-v1",
    acceptedAt: new Date().toISOString(),
  })));
  const item: {
    id: string;
    packageId: string;
    sourceId: string;
    status: string;
    outcome: string;
    code: null;
    messageCount: number;
    selectedStudent: null | { id: string; name: string; studentId: string };
    producedAt: string;
    updatedAt: string;
  } = {
    id: "handoff-test-1",
    packageId: "pkg-test-1",
    sourceId: "source-test",
    status: "pending_alignment",
    outcome: "pending_review",
    code: null,
    messageCount: 3,
    selectedStudent: null,
    producedAt: "2026-07-26T10:00:00+08:00",
    updatedAt: "2026-07-26T10:00:00+08:00",
  };
  await page.route("**/api/wecom/handoff**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/wecom/handoff" && request.method() === "GET") {
      return route.fulfill({ json: {
        items: [item],
        students: [{ id: "student-test", name: "合成学生", studentId: "TEST-001" }],
      } });
    }
    if (path === "/api/wecom/handoff" && request.method() === "POST") {
      return route.fulfill({ json: {
        scanned: 1, accepted: 0, pendingAlignment: 1, failed: 0, duplicates: 0,
      } });
    }
    if (path === "/api/wecom/handoff/handoff-test-1" && request.method() === "PATCH") {
      item.status = "pending_review";
      item.selectedStudent = { id: "student-test", name: "合成学生", studentId: "TEST-001" };
      return route.fulfill({ json: item });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/wecom");
  await page.getByRole("tab", { name: "中转仓库" }).click();
  await expect(page.getByRole("heading", { name: "WCC 中转仓库" })).toBeVisible();
  await page.getByRole("button", { name: "扫描并接收新包" }).click();
  await expect(page.getByText(/已检查 1 个文件包/)).toBeVisible();
  await page.getByLabel("匹配学生").selectOption("student-test");
  await page.getByRole("button", { name: "确认匹配并处理" }).click();
  await expect(page.getByText("已进入教师复核")).toBeVisible();
});

test("active WeCom import survives refresh and offers stop-and-rollback", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("student-track:wecom-access", JSON.stringify({
    version: "wecom-third-party-notice-v1",
    acceptedAt: new Date().toISOString(),
  })));
  let requestedMode = "";
  await page.route("**/api/wecom/auto-import", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          active: true,
          run: {
            id: "test-active-run",
            status: "running",
            messageCount: 100,
            batchCount: 20,
            communicationCount: 8,
            receiptCounts: { pending: 60, imported: 30, no_value: 5, needs_review: 5 },
            progress: 40,
            cancelRequestedAt: null,
            cancelMode: null,
          },
        }),
      });
      return;
    }
    if (route.request().method() === "DELETE") {
      requestedMode = (route.request().postDataJSON() as { mode?: string }).mode || "";
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true, rollbackRequested: true }),
      });
      return;
    }
    await route.abort();
  });

  await page.goto("/wecom");
  await expect(page.getByText("企微导入正在后台运行…")).toBeVisible();
  await expect(page.getByText("已写入 8 条 · 待处理 60 条 · 待复核 5 条")).toBeVisible();
  await page.getByRole("button", { name: "停止并回滚本次" }).click();
  await expect(page.getByRole("dialog")).toContainText("只撤销本次运行产生的增量");
  await page.getByRole("button", { name: "停止并回滚", exact: true }).click();
  await expect.poll(() => requestedMode).toBe("stop_and_rollback");
});
