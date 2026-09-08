import { afterEach, expect, it, vi } from "vitest";
import { promises as fs, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { addFeedbackAttachment } from "@/services/feedback-attachment-service";

const marker = "TEST-ATTACHMENT-SERVICE";
let root: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
  await prisma.feedbackPlan.deleteMany({ where: { semester: { name: marker } } });
  await prisma.class.deleteMany({ where: { semester: { name: marker } } });
  await prisma.semester.deleteMany({ where: { name: marker } });
});

it("cleans up an uploaded file and preserves the database error when its name contains consecutive dots", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "student-track-test-attachment-service-"));
  vi.stubEnv("STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT", root);
  const semester = await prisma.semester.create({
    data: { name: marker, startDate: "2099-01-01", endDate: "2099-12-31" },
  });
  const classroom = await prisma.class.create({
    data: { semesterId: semester.id, code: marker, name: "合成测试班" },
  });
  const plan = await prisma.feedbackPlan.create({
    data: {
      structureVersion: 2, semesterId: semester.id, classId: classroom.id, type: "event_micro",
      outputRequirement: "合成测试", inputFingerprint: "test-input", status: "ready",
    },
  });
  const directory = path.join(root, plan.id);
  const databaseError = new Error("test database failure");
  let fileWasWritten = false;
  vi.spyOn(prisma.feedbackAttachment, "create").mockImplementation(() => {
    fileWasWritten = readdirSync(directory).some((name) => name.endsWith("-test..txt"));
    throw databaseError;
  });

  const result = await addFeedbackAttachment({
    planId: plan.id, fileName: "test..txt", mimeType: "text/plain",
    bytes: new TextEncoder().encode("synthetic attachment"),
  }).catch((error: unknown) => error);

  expect(fileWasWritten).toBe(true);
  expect.soft(result).toBe(databaseError);
  expect(await fs.readdir(directory)).toEqual([]);
});
