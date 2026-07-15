import { expect, test } from "@playwright/test";

test.describe("v0.19.1 dashboard risk separation", () => {
  test("warning attention attendance and class status remain visibly separate", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 1000 });
    await page.route("**/api/alerts**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        semester: { id: "semester-test", name: "测试学期", startDate: "2026-01-01", endDate: "2026-12-31" },
        classOverview: [{ name: "测试一班", avgA: 3.2, avgB: 3.4, avgC: 3.1, avgD: 4.8, studentCount: 3, lastActivityAt: "2026-07-15T00:00:00.000Z" }],
        classAlerts: [],
        studentAlerts: [],
        studentRisks: [
          { studentId: "warning-student", studentName: "警告学生", className: "测试一班", level: "warning", signals: [{ type: "sustained-decline", label: "持续状态回落", evidence: "最近三次综合表现连续下降" }, { type: "qualitative-feedback", label: "定性反馈关注", evidence: "内部反馈：学习信心" }], qualitativeReasons: ["learning-confidence"], lastActivityAt: "2026-07-15T00:00:00.000Z" },
          { studentId: "attention-student", studentName: "关注学生", className: "测试一班", level: "attention", signals: [{ type: "persistent-below-average", label: "长期低于同期班均", evidence: "3/4 次低于同期班均" }], qualitativeReasons: [], lastActivityAt: "2026-07-14T00:00:00.000Z" },
          { studentId: "decline-student", studentName: "回落学生", className: "测试一班", level: "attention", signals: [{ type: "sustained-decline", label: "持续状态回落", evidence: "近三次持续下降" }], qualitativeReasons: [], lastActivityAt: "2026-07-13T00:00:00.000Z" },
          { studentId: "qualitative-student", studentName: "定性学生", className: "测试一班", level: "attention", signals: [{ type: "qualitative-feedback", label: "定性反馈关注", evidence: "内部反馈：家长担心" }], qualitativeReasons: ["parent-concern"], lastActivityAt: "2026-07-12T00:00:00.000Z" },
          { studentId: "early-student", studentName: "早期学生", className: "测试一班", level: "attention", signals: [{ type: "early-relative-performance", label: "早期相对表现", evidence: "前四次课相对靠后" }], qualitativeReasons: [], lastActivityAt: "2026-07-11T00:00:00.000Z" },
          { studentId: "decline-student-2", studentName: "回落学生二", className: "测试一班", level: "attention", signals: [{ type: "sustained-decline", label: "持续状态回落", evidence: "近三次持续下降" }], qualitativeReasons: [], lastActivityAt: "2026-07-10T00:00:00.000Z" },
          { studentId: "collapsed-student", studentName: "收起学生", className: "测试一班", level: "attention", signals: [{ type: "qualitative-feedback", label: "定性反馈关注", evidence: "内部反馈：学习信心" }], qualitativeReasons: ["learning-confidence"], lastActivityAt: "2026-07-09T00:00:00.000Z" },
          { studentId: "qualitative-student-3", studentName: "定性学生三", className: "测试一班", level: "attention", signals: [{ type: "qualitative-feedback", label: "定性反馈关注", evidence: "内部反馈：成绩表现" }], qualitativeReasons: ["academic-performance"], lastActivityAt: "2026-07-08T00:00:00.000Z" },
          { studentId: "qualitative-student-4", studentName: "定性学生四", className: "测试一班", level: "attention", signals: [{ type: "qualitative-feedback", label: "定性反馈关注", evidence: "内部反馈：退班意向" }], qualitativeReasons: ["withdrawal-intent"], lastActivityAt: "2026-07-07T00:00:00.000Z" },
          { studentId: "qualitative-student-5", studentName: "定性学生五", className: "测试一班", level: "attention", signals: [{ type: "qualitative-feedback", label: "定性反馈关注", evidence: "内部反馈：家长担心" }], qualitativeReasons: ["parent-concern"], lastActivityAt: "2026-07-06T00:00:00.000Z" },
          { studentId: "column-collapsed-student", studentName: "栏内收起学生", className: "测试一班", level: "attention", signals: [{ type: "qualitative-feedback", label: "定性反馈关注", evidence: "内部反馈：学习信心" }], qualitativeReasons: ["learning-confidence"], lastActivityAt: "2026-07-05T00:00:00.000Z" },
        ],
        attendanceReminders: [{ studentId: "attendance-student", studentName: "考勤学生", className: "测试一班", absenceCount: 2, level: "attention" }],
        totalStudents: 12,
        redCount: 1,
        yellowCount: 10,
        warningCount: 1,
        attentionCount: 10,
      }),
    }));

    await page.goto("/");
    const warning = page.locator(".dashboard-risk-section--warning");
    const attention = page.locator(".dashboard-risk-section--attention");
    const attendance = page.locator(".dashboard-risk-section--attendance");
    await expect(warning).toContainText("警告——需要优先处理");
    await expect(warning).toContainText("警告学生");
    await expect(warning).not.toContainText("关注学生");
    await expect(attention).toContainText("持续关注");
    await expect(attention).toContainText("关注学生");
    await expect(attention.getByRole("heading", { name: "状态回落" })).toBeVisible();
    await expect(attention.getByRole("heading", { name: "表现观察" })).toBeVisible();
    await expect(attention.getByRole("heading", { name: "定性反馈" })).toBeVisible();
    await expect(attention).toContainText("回落学生");
    await expect(attention).toContainText("定性学生");
    await expect(attention).not.toContainText("栏内收起学生");
    await expect(attention.locator(".dashboard-alert-list--compact .dashboard-alert-row")).toHaveCount(9);
    await attention.getByRole("button", { name: "同时展开三栏（其余 1 人）" }).click();
    await expect(attention).toContainText("栏内收起学生");
    await expect(attention.locator(".dashboard-alert-list--compact .dashboard-alert-row")).toHaveCount(10);
    await attention.getByRole("button", { name: "同时收起三栏" }).click();
    await expect(attention.locator(".dashboard-alert-list--compact .dashboard-alert-row")).toHaveCount(9);
    await expect(attendance).toContainText("考勤提醒");
    await expect(attendance).toContainText("考勤学生");
    await expect(page.getByRole("heading", { name: "班级状态" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.setViewportSize({ width: 1440, height: 1000 });
    const columns = attention.locator(".dashboard-attention-column");
    await expect(columns).toHaveCount(3);
    const boxes = await Promise.all([0, 1, 2].map((index) => columns.nth(index).boundingBox()));
    expect(boxes.every(Boolean)).toBe(true);
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
    expect(Math.abs(boxes[1]!.y - boxes[2]!.y)).toBeLessThan(2);
    expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
    expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x);
  });
});
