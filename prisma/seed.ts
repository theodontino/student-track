import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import "dotenv/config";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const adapter = new PrismaLibSql({ url });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Clean existing data
  await prisma.attendance.deleteMany();
  await prisma.classSession.deleteMany();
  await prisma.semester.deleteMany();
  await prisma.draftRecord.deleteMany();
  await prisma.event.deleteMany();
  await prisma.communication.deleteMany();
  await prisma.dailyMetric.deleteMany();
  await prisma.student.deleteMany();

  // Create students
  const s1 = await prisma.student.create({
    data: {
      name: "张三",
      class: "高三(1)班",
      studentId: "2024001",
      gender: "男",
      labels: JSON.stringify(["#逻辑强", "#基础扎实"]),
    },
  });

  const s2 = await prisma.student.create({
    data: {
      name: "李四",
      class: "高三(1)班",
      studentId: "2024002",
      gender: "女",
      labels: JSON.stringify(["#敏感", "#基础弱", "#用功"]),
    },
  });

  const s3 = await prisma.student.create({
    data: {
      name: "王五",
      class: "高三(1)班",
      studentId: "2024003",
      gender: "男",
      labels: JSON.stringify(["#调皮", "#聪明"]),
    },
  });

  // Create sample metrics for the past 7 days
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];

    await prisma.dailyMetric.create({
      data: {
        studentId: s1.id,
        date: dateStr,
        scoreA: Math.min(5, 4 + Math.floor(Math.random() * 2)),
        scoreB: Math.min(5, 3 + Math.floor(Math.random() * 3)),
        scoreC: Math.min(5, 3 + Math.floor(Math.random() * 3)),
      },
    });

    await prisma.dailyMetric.create({
      data: {
        studentId: s2.id,
        date: dateStr,
        scoreA: Math.min(5, 2 + Math.floor(Math.random() * 3)),
        scoreB: Math.min(5, 2 + Math.floor(Math.random() * 3)),
        scoreC: Math.min(5, 3 + Math.floor(Math.random() * 2)),
      },
    });

    await prisma.dailyMetric.create({
      data: {
        studentId: s3.id,
        date: dateStr,
        scoreA: Math.min(5, 3 + Math.floor(Math.random() * 3)),
        scoreB: Math.min(5, 1 + Math.floor(Math.random() * 3)),
        scoreC: Math.min(5, 2 + Math.floor(Math.random() * 3)),
      },
    });
  }

  // Create sample events
  await prisma.event.create({
    data: {
      studentId: s1.id,
      date: today.toISOString().split("T")[0],
      type: "测验成绩",
      description: "氧化还原反应测验全对",
      rawText: "今天张三测验氧化还原全对",
    },
  });

  await prisma.event.create({
    data: {
      studentId: s2.id,
      date: today.toISOString().split("T")[0],
      type: "心理状态",
      description: "情绪低落，作业没交",
      rawText: "李四作业没交，情绪低落",
    },
  });

  // Create sample communication
  await prisma.communication.create({
    data: {
      studentId: s2.id,
      date: today.toISOString().split("T")[0],
      target: "母亲",
      summary: "电话沟通，确认李四近期因家庭事务分心，已与家长协商关注方案",
    },
  });

  // Create semester and sessions
  const semester = await prisma.semester.create({
    data: {
      name: "2024-2025学年第一学期",
      startDate: new Date(today.getTime() - 14 * 86400000).toISOString().split("T")[0],
      endDate: new Date(today.getTime() + 90 * 86400000).toISOString().split("T")[0],
    },
  });

  const className = "高三(1)班";

  // Create 7 class sessions (past 7 days) with new code system
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const code = dateStr.replace(/-/g, "") + "01"; // e.g., "2026060401"
    const sessionNum = 7 - i + 1; // session 1..7

    const session = await prisma.classSession.create({
      data: {
        code,
        semesterId: semester.id,
        semesterNumber: sessionNum,
        date: dateStr,
        class: className,
      },
    });

    // Default all students present, except 李四 absent on day 3 & 5
    for (const s of [s1, s2, s3]) {
      const absent = s.name === "李四" && (sessionNum === 3 || sessionNum === 5);
      await prisma.attendance.create({
        data: {
          sessionId: session.id,
          studentId: s.id,
          present: !absent,
        },
      });
    }
  }

  console.log("✅ Seed data created successfully!");
  console.log(`   Students: ${s1.name}, ${s2.name}, ${s3.name}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
