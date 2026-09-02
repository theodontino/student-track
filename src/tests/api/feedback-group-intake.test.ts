import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createFeedbackGroupIntake: vi.fn(),
  prepareFeedbackGroupIntakeFromExistingFacts: vi.fn(),
  createOrGetFeedbackIntakeRun: vi.fn(),
  prepareFeedbackIntakeFromExistingFacts: vi.fn(),
  filesFromInbox: vi.fn(),
}));

vi.mock("@/services/feedback-group-intake-service", () => ({
  createFeedbackGroupIntake: mocks.createFeedbackGroupIntake,
  prepareFeedbackGroupIntakeFromExistingFacts: mocks.prepareFeedbackGroupIntakeFromExistingFacts,
  parseFeedbackGroupRunIds(value: unknown) {
    if (value === undefined || value === null || value === "") return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runIds 参数无效");
    return value;
  },
  parseFeedbackGroupSessionCodes(value: unknown) {
    if (value === undefined || value === null || value === "") return undefined;
    if (!Array.isArray(value) || !value.length) throw new Error("sessionCodes 参数无效");
    return value;
  },
}));

vi.mock("@/services/feedback-intake-service", () => ({
  createOrGetFeedbackIntakeRun: mocks.createOrGetFeedbackIntakeRun,
  prepareFeedbackIntakeFromExistingFacts: mocks.prepareFeedbackIntakeFromExistingFacts,
  filesFromInbox: mocks.filesFromInbox,
}));

import { POST as uploadGroup } from "@/app/api/feedback/intake/group-upload/route";
import { POST as scanGroup } from "@/app/api/feedback/intake/group-scan/route";
import { POST as scanSingle } from "@/app/api/feedback/intake/scan/route";

const result = {
  runs: [{ id: "run-1", sessionCode: "SESSION-1" }],
  classes: [{ classId: "class-1", sessionCode: "SESSION-1", runId: "run-1" }],
  sourceSummaries: [],
  unassigned: [],
};

beforeEach(() => {
  mocks.createFeedbackGroupIntake.mockReset().mockResolvedValue(result);
  mocks.prepareFeedbackGroupIntakeFromExistingFacts.mockReset().mockResolvedValue(result);
  mocks.createOrGetFeedbackIntakeRun.mockReset().mockResolvedValue({ run: result.runs[0] });
  mocks.prepareFeedbackIntakeFromExistingFacts.mockReset().mockResolvedValue({ run: result.runs[0] });
  mocks.filesFromInbox.mockReset().mockResolvedValue([]);
});

describe("feedback group intake routes", () => {
  it("passes multipart files, display names and reusable run IDs to group intake", async () => {
    const form = new FormData();
    form.set("groupLessonId", "lesson-1");
    form.set("sessionCodes", JSON.stringify(["SESSION-2"]));
    form.set("runIds", JSON.stringify({ "SESSION-2": "run-2" }));
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
    expect(input).toMatchObject({
      groupLessonId: "lesson-1",
      sessionCodes: ["SESSION-2"],
      runIds: { "SESSION-2": "run-2" },
    });
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
      body: JSON.stringify({
        groupLessonId: "lesson-1",
        sessionCodes: ["SESSION-2"],
        runIds: { "SESSION-2": "run-2" },
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.filesFromInbox).toHaveBeenCalledOnce();
    expect(mocks.createFeedbackGroupIntake).toHaveBeenCalledWith({
      groupLessonId: "lesson-1",
      files: [],
      sessionCodes: ["SESSION-2"],
      runIds: { "SESSION-2": "run-2" },
    });
  });

  it("uses the explicit existing-facts service without scanning the group inbox", async () => {
    const response = await scanGroup(new NextRequest("http://127.0.0.1/api/feedback/intake/group-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupLessonId: "lesson-1",
        sessionCodes: ["SESSION-2"],
        runIds: { "SESSION-2": "run-2" },
        useExistingFacts: true,
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.filesFromInbox).not.toHaveBeenCalled();
    expect(mocks.createFeedbackGroupIntake).not.toHaveBeenCalled();
    expect(mocks.prepareFeedbackGroupIntakeFromExistingFacts).toHaveBeenCalledWith({
      groupLessonId: "lesson-1",
      sessionCodes: ["SESSION-2"],
      runIds: { "SESSION-2": "run-2" },
    });
    await expect(response.json()).resolves.toMatchObject({ source: "existing_facts" });
  });

  it("uses the explicit existing-facts service for one class without scanning the inbox", async () => {
    const response = await scanSingle(new NextRequest("http://127.0.0.1/api/feedback/intake/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionCode: "SESSION-1", runId: "run-1", useExistingFacts: true }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.filesFromInbox).not.toHaveBeenCalled();
    expect(mocks.createOrGetFeedbackIntakeRun).not.toHaveBeenCalled();
    expect(mocks.prepareFeedbackIntakeFromExistingFacts).toHaveBeenCalledWith({
      sessionCode: "SESSION-1",
      runId: "run-1",
    });
    await expect(response.json()).resolves.toMatchObject({ source: "existing_facts" });
  });
});
