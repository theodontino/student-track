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
  await page.getByRole("tab", { name: "接收与诊断" }).click();
  await expect(page.getByRole("heading", { name: "接收与诊断" })).toBeVisible();
  await page.getByRole("button", { name: "扫描并接收新包" }).click();
  await expect(page.getByText(/已检查 1 个文件包/)).toBeVisible();
  await page.getByLabel("匹配学生").selectOption("student-test");
  await page.getByRole("button", { name: "确认匹配并处理" }).click();
  await expect(page.getByText("处理完成", { exact: true })).toBeVisible();
  await page.getByLabel("查看").selectOption("review");
  await expect(page.getByText("已进入教师复核")).toBeVisible();
  await expect(page.getByText("合成学生", { exact: true })).toBeVisible();
  await expect(page.locator("code", { hasText: "pkg-test-1" })).toBeVisible();
});

test("handoff receipt repair requires a read-only preflight and explicit confirmation", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("student-track:wecom-access", JSON.stringify({
    version: "wecom-third-party-notice-v1",
    acceptedAt: new Date().toISOString(),
  })));
  let repaired = false;
  await page.route("**/api/wecom/handoff/receipt-repair", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: {
      alreadyLinked: 2, missingReceiptId: 3, eligible: 2, linkExisting: 1, createReceipt: 1, skipped: { missing_package: 1 },
    } });
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ confirmation: "REPAIR_HANDOFF_RECEIPTS" });
      repaired = true;
      return route.fulfill({ json: { linkedExisting: 1, createdReceipts: 1 } });
    }
    return route.abort();
  });
  await page.route("**/api/wecom/handoff", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { items: [], students: [] } });
    return route.abort();
  });

  await page.goto("/wecom");
  await page.getByRole("button", { name: "只读预检历史回执" }).click();
  await expect(page.getByText("回执只读预检完成：2 条可修复，1 条跳过")).toBeVisible();
  const repair = page.getByRole("button", { name: "备份后修复 receiptId" });
  await expect(repair).toBeDisabled();
  await page.getByLabel("回执修复确认").fill("REPAIR_HANDOFF_RECEIPTS");
  await repair.click();
  await expect.poll(() => repaired).toBe(true);
  await expect(page.getByText("回执修复完成：关联已有 1，新建 1；数据库备份已验证")).toBeVisible();
});
