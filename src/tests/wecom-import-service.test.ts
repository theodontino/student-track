import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { applyWeComCommunicationImport, planWeComCommunicationImport } from "@/services/wecom-import-service";

describe("wecom import service", () => {
  it("plans unknown-session communication with first class session fallback", async () => {
    const student = await prisma.student.findFirst({
      select: { id: true, name: true, studentId: true },
      orderBy: { studentId: "asc" },
    });
    expect(student).toBeTruthy();

    const result = await planWeComCommunicationImport(prisma, {
      jsonText: JSON.stringify({
        source: "wecomcatch",
        mode: "candidateOnly",
        records: [
          {
            kind: "communication",
            source: { conversationId: "ax-vitest", conversationTitle: `${student!.name}妈妈` },
            matchedStudent: {
              id: student!.id,
              name: student!.name,
              studentId: student!.studentId,
              confidence: "high",
            },
            occurredAt: "2026-07-02",
            sessionCode: null,
            target: "母亲",
            summary: "家长反馈孩子近期状态稳定，老师建议继续保持复盘。",
            confidence: "high",
          },
        ],
      }),
    });

    expect(result.communicationCandidateCount).toBe(1);
    expect(result.importableCount).toBe(1);
    expect(result.plans[0]).toMatchObject({
      binding: "first_class_session_fallback",
      target: "母亲",
      student: { name: student!.name, studentId: student!.studentId },
    });
    expect(result.plans[0].summary).toContain("企微长期沟通");
  });

  it("adds only high-confidence internal labels when a new communication is applied", async () => {
    const student = await prisma.student.findFirst({ select: { id: true, name: true, studentId: true }, orderBy: { studentId: "asc" } });
    expect(student).toBeTruthy();
    const conversationId = `attention-${student!.id}`;
    const jsonText = JSON.stringify({ records: [{
      kind: "communication",
      source: { conversationId, conversationTitle: `${student!.name}家长` },
      matchedStudent: { id: student!.id, name: student!.name, studentId: student!.studentId, confidence: "high" },
      target: "家长",
      summary: `测试定性关注 ${conversationId}`,
      attentionSignals: [
        { reason: "parent-concern", confidence: "high", evidenceSummary: "家长明确表示担心" },
        { reason: "withdrawal-intent", confidence: "medium", evidenceSummary: "可能考虑退班" },
      ],
    }] });

    const applied = await applyWeComCommunicationImport(prisma, { jsonText, skipBackup: true });
    expect(applied).toMatchObject({ createdCount: 1, createdLabelCount: 1, attentionCandidateCount: 2 });
    await expect(prisma.studentLabel.findMany({ where: { studentId: student!.id }, include: { label: true } })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.objectContaining({ name: "AI内部关注：家长担心" }) }),
    ]));

    await prisma.studentLabel.deleteMany({ where: { studentId: student!.id, label: { name: "AI内部关注：家长担心" } } });
    await expect(applyWeComCommunicationImport(prisma, { jsonText, skipBackup: true })).resolves.toMatchObject({ createdCount: 0, createdLabelCount: 0 });
    await expect(prisma.studentLabel.findFirst({ where: { studentId: student!.id, label: { name: "AI内部关注：家长担心" } } })).resolves.toBeNull();
    await prisma.communication.deleteMany({ where: { studentId: student!.id, summary: { contains: conversationId } } });
    await prisma.label.deleteMany({ where: { name: "AI内部关注：家长担心", students: { none: {} } } });
  });

  it("rejects records outside the conversation student and message boundaries", async () => {
    const student = await prisma.student.findFirst({
      select: { id: true, name: true, studentId: true },
      orderBy: { studentId: "asc" },
    });
    expect(student).toBeTruthy();
    const result = await planWeComCommunicationImport(prisma, {
      jsonText: JSON.stringify({ records: [{
        kind: "communication",
        source: {
          conversationId: "conversation-allowed",
          conversationTitle: `${student!.name}家长`,
          messageIds: ["invented-message"],
        },
        matchedStudent: {
          id: student!.id,
          name: student!.name,
          studentId: student!.studentId,
          confidence: "high",
        },
        target: "家长",
        summary: "不应越界写入",
      }] }),
      allowedStudentIds: [student!.id],
      allowedMessageIds: ["real-message"],
      expectedConversationId: "conversation-allowed",
      requireMessageIds: true,
    });

    expect(result).toMatchObject({
      importableCount: 0,
      skippedCount: 1,
      skipped: [{ reason: "source_message_outside_batch" }],
    });
  });

  it("deduplicates repeated records inside one candidate batch", async () => {
    const student = await prisma.student.findFirst({
      select: { id: true, name: true, studentId: true },
      orderBy: { studentId: "asc" },
    });
    expect(student).toBeTruthy();
    const base = {
      kind: "communication",
      source: { conversationId: "batch-dedupe", conversationTitle: `${student!.name}家长` },
      matchedStudent: {
        id: student!.id,
        name: student!.name,
        studentId: student!.studentId,
        confidence: "high",
      },
      target: "家长",
      summaryForChemTrack: "同一批内的相同摘要",
    };
    const result = await planWeComCommunicationImport(prisma, {
      jsonText: JSON.stringify({ records: [
        { ...base, sourceKey: "batch-dedupe:first" },
        { ...base, sourceKey: "batch-dedupe:second" },
      ] }),
    });

    expect(result).toMatchObject({ importableCount: 2, createCount: 1, duplicateCount: 1 });
  });
});
