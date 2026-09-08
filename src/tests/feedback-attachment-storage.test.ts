import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFeedbackAttachment, withFeedbackAttachmentRemoval, withFeedbackPlanDirectoryRemoval, writeFeedbackAttachment } from "@/services/feedback-attachment-storage";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

async function fixture() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "student-track-test-attachment-storage-"));
  vi.stubEnv("STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT", root);
  return writeFeedbackAttachment("test-plan", "test-note.txt", new TextEncoder().encode("synthetic attachment"));
}

describe("feedback attachment storage", () => {
  it("restores a quarantined file when removing its record fails", async () => {
    const { relativeLocator } = await fixture();
    await expect(withFeedbackAttachmentRemoval("test-plan", relativeLocator, async () => {
      await expect(readFeedbackAttachment("test-plan", relativeLocator)).rejects.toMatchObject({ code: "ENOENT" });
      throw new Error("test database failure");
    })).rejects.toThrow("test database failure");
    expect((await readFeedbackAttachment("test-plan", relativeLocator)).toString()).toBe("synthetic attachment");
  });

  it("restores the entire plan directory when the database transaction fails", async () => {
    const { relativeLocator } = await fixture();
    await expect(withFeedbackPlanDirectoryRemoval("test-plan", [{ relativeLocator }], async () => {
      throw new Error("test transaction failure");
    })).rejects.toThrow("test transaction failure");
    expect((await readFeedbackAttachment("test-plan", relativeLocator)).toString()).toBe("synthetic attachment");
    await expect(withFeedbackPlanDirectoryRemoval("test-plan", [{ relativeLocator }], async () => "deleted")).resolves.toBe("deleted");
    expect(await fs.readdir(root!)).toEqual([]);
  });
});
