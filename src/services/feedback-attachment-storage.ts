import { resolveStudentTrackRuntimePath } from "@/lib/runtime-paths";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function feedbackAttachmentRoot() {
  return path.resolve(resolveStudentTrackRuntimePath(
    "feedback-attachments",
    "STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT",
    path.join(os.homedir(), "Library", "Application Support", "Student Track", "feedback-attachments"),
  ));
}

/** Removes only the controlled per-plan attachment directories after their database rows are purged. */
export async function purgeFeedbackAttachmentDirectories(planIds: string[]) {
  const root = feedbackAttachmentRoot();
  for (const planId of [...new Set(planIds)]) {
    const directory = path.resolve(root, planId);
    const relative = path.relative(root, directory);
    if (relative !== planId || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("反馈计划附件目录无效");
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export function safeAttachmentName(name: string) {
  const base = path.basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 160);
  return base || "attachment";
}

export function attachmentDestination(planId: string, relativeLocator: string) {
  const prefix = `${path.posix.join("feedback-attachments", planId)}/`;
  if (!relativeLocator.startsWith(prefix)) throw new Error("附件定位符不在受控目录内");
  const filePart = relativeLocator.slice(prefix.length);
  if (!filePart || filePart.includes("..") || path.posix.isAbsolute(filePart)) throw new Error("附件定位符无效");
  const root = feedbackAttachmentRoot();
  const destination = path.resolve(root, planId, ...filePart.split("/"));
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("附件路径越界");
  return destination;
}

export async function readFeedbackAttachment(planId: string, relativeLocator: string) {
  return fs.readFile(attachmentDestination(planId, relativeLocator));
}

export async function writeFeedbackAttachment(planId: string, fileName: string, bytes: Uint8Array) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const storedName = `${randomUUID()}-${safeAttachmentName(fileName)}`;
  const relativeLocator = path.posix.join("feedback-attachments", planId, storedName);
  const destination = path.join(feedbackAttachmentRoot(), planId, storedName);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, bytes, { mode: 0o600 });
  return {
    hash,
    relativeLocator,
    // Failed persistence must discard the exact file written by this operation.
    discard: async () => { await fs.unlink(destination).catch(() => undefined); },
  };
}

export async function withFeedbackAttachmentRemoval<T>(planId: string, relativeLocator: string, removeRecord: () => Promise<T>) {
  const destination = attachmentDestination(planId, relativeLocator);
  const quarantine = `${destination}.delete-${randomUUID()}`;
  let moved = false;
  try {
    await fs.rename(destination, quarantine);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const result = await removeRecord();
    if (moved) await fs.unlink(quarantine).catch(() => undefined);
    return result;
  } catch (error) {
    if (moved) await fs.rename(quarantine, destination).catch(() => undefined);
    throw error;
  }
}

export async function withFeedbackPlanDirectoryRemoval<T>(id: string, attachments: Array<{ relativeLocator: string }>, removeRecord: () => Promise<T>) {
  // Validate every persisted locator before moving anything. A corrupted row
  // must fail closed rather than allowing deletion to operate on an unknown
  // path, even though the normal plan directory is itself controlled.
  for (const attachment of attachments) attachmentDestination(id, attachment.relativeLocator);
  const root = feedbackAttachmentRoot();
  const planDirectory = path.resolve(root, id);
  const relative = path.relative(root, planDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative !== id) throw new Error("反馈计划附件目录无效");
  const quarantineDirectory = path.resolve(root, `.deleted-${id}-${randomUUID()}`);
  let moved = false;
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    try { await fs.rename(planDirectory, quarantineDirectory); moved = true; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    const result = await removeRecord();
    if (moved) await fs.rm(quarantineDirectory, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (moved) await fs.rename(quarantineDirectory, planDirectory).catch(() => undefined);
    throw error;
  }
}
