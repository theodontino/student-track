import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  claimWeComAutoImportRun,
  collectIncrementalWeComSources,
} from "@/services/wecom-auto-import-service";

describe("wecom auto import service", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    await prisma.weComMessageReceipt.deleteMany({
      where: { conversationId: { startsWith: "test-auto-" } },
    });
    await prisma.weComImportRun.deleteMany({
      where: { id: { startsWith: "test-auto-" } },
    });
    await prisma.weComImportState.deleteMany({ where: { id: "default" } });
  });

  it("collects only new messages from conversations whose title matches the roster", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wecom-auto-import-"));
    tempDirs.push(root);
    const conversations = path.join(root, "exports", "conversations");
    const matched = path.join(conversations, "conversation-1");
    const unmatched = path.join(conversations, "conversation-2");
    await mkdir(matched, { recursive: true });
    await mkdir(unmatched, { recursive: true });
    await writeFile(path.join(matched, "archive.md"), "# 张三妈妈-example\n", "utf8");
    await writeFile(path.join(unmatched, "archive.md"), "# 其他联系人-example\n", "utf8");
    await writeFile(path.join(matched, "messages.jsonl"), [
      JSON.stringify({ sent_at: "2026-06-01T08:00:00Z", direction: "incoming", content: "旧消息" }),
      JSON.stringify({ sent_at: "2026-07-18T08:00:00Z", direction: "incoming", content: "近期希望多鼓励" }),
    ].join("\n"), "utf8");
    await writeFile(path.join(unmatched, "messages.jsonl"), `${JSON.stringify({ sent_at: "2026-07-18T08:00:00Z", content: "不应读取" })}\n`, "utf8");

    const prisma = {
      student: { findMany: async () => [{ id: "student-zhang", name: "张三" }] },
    } as any;
    const result = await collectIncrementalWeComSources(
      prisma,
      root,
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-19T00:00:00Z"),
    );

    expect(result).toMatchObject({ messageCount: 1 });
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].messages[0].text).toContain("近期希望多鼓励");
    expect(result.conversations[0].messages[0].text).not.toContain("旧消息");
  });

  it("does not select a message already recorded as imported", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wecom-auto-import-"));
    tempDirs.push(root);
    const conversation = path.join(root, "exports", "conversations", "conversation-1");
    await mkdir(conversation, { recursive: true });
    await writeFile(path.join(conversation, "archive.md"), "# 张三妈妈-example\n", "utf8");
    const message = { id: "message-imported", sent_at: "2026-07-18T08:00:00Z", content: "已处理消息" };
    await writeFile(path.join(conversation, "messages.jsonl"), `${JSON.stringify(message)}\n`, "utf8");
    const crypto = await import("node:crypto");
    const contentHash = crypto.createHash("sha256")
      .update([message.sent_at, "", "", message.content].join("\n"))
      .digest("hex");
    const prisma = {
      student: { findMany: async () => [{ id: "student-zhang", name: "张三" }] },
    } as any;

    const result = await collectIncrementalWeComSources(
      prisma,
      root,
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-19T00:00:00Z"),
      new Map([[`conversation-1\0${message.id}`, { contentHash, status: "imported" }]]),
    );

    expect(result).toMatchObject({ messageCount: 0, conversations: [] });
  });

  it("allows only one active one-click import lease", async () => {
    const startedAt = new Date("2026-07-20T00:00:00Z");
    const first = await claimWeComAutoImportRun(prisma, startedAt);
    await prisma.weComImportRun.update({
      where: { id: first.runId },
      data: { id: `test-auto-${first.runId}` },
    });
    await prisma.weComImportState.update({
      where: { id: "default" },
      data: { activeRunId: `test-auto-${first.runId}` },
    });

    await expect(claimWeComAutoImportRun(prisma, startedAt))
      .rejects.toThrow("已有企微一键导入正在运行");
  });

  it("recovers stale extracting receipts and includes their time in the next window", async () => {
    const staleAt = new Date("2026-07-19T00:00:00Z");
    await prisma.weComImportState.create({
      data: {
        id: "default",
        initializedAfter: new Date("2026-06-01T00:00:00Z"),
        lastSucceededUntil: new Date("2026-07-19T23:00:00Z"),
        activeRunId: "test-auto-stale-run",
        activeRunStartedAt: staleAt,
      },
    });
    await prisma.weComMessageReceipt.create({
      data: {
        conversationId: "test-auto-conversation",
        messageId: "stale-message",
        sentAt: new Date("2026-07-10T00:00:00Z"),
        contentHash: "stale-hash",
        status: "extracting",
        promptVersion: "test",
        updatedAt: staleAt,
      },
    });

    const claimed = await claimWeComAutoImportRun(prisma, new Date("2026-07-20T12:00:00Z"));
    await prisma.weComImportRun.update({
      where: { id: claimed.runId },
      data: { id: `test-auto-${claimed.runId}` },
    });
    await prisma.weComImportState.update({
      where: { id: "default" },
      data: { activeRunId: `test-auto-${claimed.runId}` },
    });

    await expect(prisma.weComMessageReceipt.findUnique({
      where: {
        conversationId_messageId: {
          conversationId: "test-auto-conversation",
          messageId: "stale-message",
        },
      },
    })).resolves.toMatchObject({ status: "failed" });
    expect(claimed.since.toISOString()).toBe("2026-07-09T23:55:00.000Z");
  });
});
