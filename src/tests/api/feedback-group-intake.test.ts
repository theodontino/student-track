import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createFeedbackGroupIntake: vi.fn(),
  filesFromInbox: vi.fn(),
}));

vi.mock("@/services/feedback-group-intake-service", () => ({
  createFeedbackGroupIntake: mocks.createFeedbackGroupIntake,
  parseFeedbackGroupRunIds(value: unknown) {
    if (value === undefined || value === null || value === "") return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runIds 参数无效");
    return value;
  },
}));

vi.mock("@/services/feedback-intake-service", () => ({
  filesFromInbox: mocks.filesFromInbox,
}));

import { POST as uploadGroup } from "@/app/api/feedback/intake/group-upload/route";
import { POST as scanGroup } from "@/app/api/feedback/intake/group-scan/route";

const result = {
  runs: [{ id: "run-1", sessionCode: "SESSION-1" }],
  classes: [{ classId: "class-1", sessionCode: "SESSION-1", runId: "run-1" }],
  sourceSummaries: [],
  unassigned: [],
};

beforeEach(() => {
  mocks.createFeedbackGroupIntake.mockReset().mockResolvedValue(result);
  mocks.filesFromInbox.mockReset().mockResolvedValue([]);
});

describe("feedback group intake routes", () => {
  it("passes multipart files, display names and reusable run IDs to group intake", async () => {
    const form = new FormData();
    form.set("groupLessonId", "lesson-1");
    form.set("runIds", JSON.stringify({ "SESSION-1": "run-1" }));
    form.set("displayNames", JSON.stringify(["文件夹/课堂.step-classroom.txt"]));
    form.append("files", new File(["STEP synthetic"], "课堂.step-classroom.txt", { type: "text/plain" }));
    const response = await uploadGroup(new NextRequest("http://127.0.0.1/api/feedback/intake/group-upload", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(result);
    expect(mocks.createFeedbackGroupIntake).toHaveBeenCalledOnce();
    const input = mocks.createFeedbackGroupIntake.mock.calls[0]![0];
    expect(input).toMatchObject({ groupLessonId: "lesson-1", runIds: { "SESSION-1": "run-1" } });
    expect(input.files).toHaveLength(1);
    expect(input.files[0]).toMatchObject({ name: "文件夹/课堂.step-classroom.txt", source: "upload" });
  });

  it("keeps empty multipart uploads out of the upload endpoint", async () => {
    const form = new FormData();
    form.set("groupLessonId", "lesson-1");
    const response = await uploadGroup(new NextRequest("http://127.0.0.1/api/feedback/intake/group-upload", {
      method: "POST",
      body: form,
    }));
    expect(response.status).toBe(400);
    expect(mocks.createFeedbackGroupIntake).not.toHaveBeenCalled();
  });

  it("scans the inbox and allows an empty file list to create linked class runs", async () => {
    const response = await scanGroup(new NextRequest("http://127.0.0.1/api/feedback/intake/group-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupLessonId: "lesson-1", runIds: { "SESSION-1": "run-1" } }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.filesFromInbox).toHaveBeenCalledOnce();
    expect(mocks.createFeedbackGroupIntake).toHaveBeenCalledWith({
      groupLessonId: "lesson-1",
      files: [],
      runIds: { "SESSION-1": "run-1" },
    });
  });
});
