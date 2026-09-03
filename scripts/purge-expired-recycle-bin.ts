import "dotenv/config";

async function main() {
  const { purgeExpiredRecycleBin } = await import("../src/services/academic-scope-recycle-service");
  const result = await purgeExpiredRecycleBin();
  if (result.purgedSemesters || result.purgedClasses) {
    console.log(`回收站清理完成：${result.purgedSemesters} 个学期，${result.purgedClasses} 个班级`);
  }
}

main().catch((error) => {
  console.error("回收站到期清理失败；数据保持不变，启动继续：", error instanceof Error ? error.message : error);
});
