import { prisma } from "../src/lib/prisma";

const semesterId = "test-feedback-kit-semester";
const studentIds = Array.from({ length: 6 }, (_, index) => `test-feedback-kit-student-${index + 1}`);

async function main() {
  const existing = await prisma.semester.findUnique({ where: { id: semesterId }, select: { name: true } });
  if (!existing) {
    console.log("测试班级组不存在，无需清理");
    return;
  }
  if (existing.name !== "【测试】课后工作台匹配验收") throw new Error("固定测试学期 ID 指向了非测试数据，拒绝清理");
  await prisma.$transaction(async (tx) => {
    await tx.feedbackPlanBatch.deleteMany({ where: { semesterId } });
    await tx.feedbackPlan.deleteMany({ where: { semesterId } });
    await tx.classGroup.deleteMany({ where: { semesterId } });
    await tx.classSession.deleteMany({ where: { semesterId } });
    await tx.studentClassEnrollment.deleteMany({ where: { semesterId } });
    await tx.class.deleteMany({ where: { semesterId } });
    await tx.semester.delete({ where: { id: semesterId } });
    await tx.student.deleteMany({ where: { id: { in: studentIds } } });
  });
  console.log("测试班级组及其合成业务记录已清理");
}

main().finally(() => prisma.$disconnect());
