import { afterEach, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { CommunicationPreferenceSchema } from "@/lib/feedback-plan";
import { createPreferenceCandidate, resolvePreferenceCandidate } from "@/services/communication-preference-service";

const marker = "TEST-PREFERENCE-SERVICE";
afterEach(async () => {
  await prisma.student.deleteMany({ where: { studentId: marker } });
});

it("rejects a candidate without replacing the confirmed preference, and supersedes only on confirmation", async () => {
  const student = await prisma.student.create({ data: { studentId: marker, name: "张三", gender: "男" } });
  const preference = CommunicationPreferenceSchema.parse({ version: 1, length: "detailed", deliveryChannel: "text", phoneContact: "accepted", evidence: "unknown", terminology: "unknown", familyParticipation: "unknown", frequency: "every_session" });
  const first = await createPreferenceCandidate({ studentId: student.id, sourceType: "teacher", preference });
  await resolvePreferenceCandidate(first.id, "confirmed");
  const confirmed = await prisma.communicationPreference.findUniqueOrThrow({ where: { studentId: student.id } });
  const rejected = await createPreferenceCandidate({ studentId: student.id, sourceType: "teacher", preference });
  await resolvePreferenceCandidate(rejected.id, "rejected");
  expect(await prisma.communicationPreference.findUniqueOrThrow({ where: { studentId: student.id } })).toEqual(confirmed);
  const replacement = await createPreferenceCandidate({ studentId: student.id, sourceType: "teacher", preference });
  await resolvePreferenceCandidate(replacement.id, "confirmed");
  expect((await prisma.communicationPreferenceCandidate.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("superseded");
  expect((await prisma.communicationPreference.findUniqueOrThrow({ where: { studentId: student.id } })).sourceCandidateId).toBe(replacement.id);
});
