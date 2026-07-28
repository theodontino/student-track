import { expect, test } from "@playwright/test";

test.describe("v0.19.0 workflow UX", () => {
  test("handoff package identifiers stay inside the dedicated workspace card", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("student-track:wecom-access", JSON.stringify({
      version: "wecom-third-party-notice-v1",
      acceptedAt: new Date().toISOString(),
    })));
    const longPackageId = "wcc.student-track-file.v1-package-20260715-very-long-immutable-identity-that-must-not-expand-the-workspace.json";
    await page.route("**/api/wecom/handoff", (route) => route.fulfill({ json: {
      items: [{
        id: "handoff-long-id",
        packageId: longPackageId,
        sourceId: "source-long-id",
        status: "pending_review",
        outcome: "pending_review",
        code: null,
        messageCount: 1,
        selectedStudent: { id: "student-1", name: "测试甲", studentId: "TEST-001" },
        producedAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      }],
      students: [],
    } }));
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.goto("/wecom");
    const output = page.locator("code", { hasText: longPackageId });
    await expect(output).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const card = output.locator("xpath=ancestor::article[1]");
    const [outputBox, cardBox] = await Promise.all([output.boundingBox(), card.boundingBox()]);
    expect(outputBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(outputBox!.x + outputBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
  });
});
