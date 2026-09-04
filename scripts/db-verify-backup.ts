import "dotenv/config";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyDatabaseBackup } from "../src/services/database-backup-service";
import { resolveStudentTrackArchiveRoot } from "../src/lib/runtime-paths";

async function latestBackup(archiveDir: string) {
  const files = (await readdir(archiveDir)).filter(
    (file) => file.endsWith(".db") && !file.startsWith("pre-restore_")
  );
  const candidates = await Promise.all(files.map(async (file) => {
    const path = resolve(archiveDir, file);
    return { path, modifiedAt: (await stat(path)).mtimeMs };
  }));
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  if (!candidates[0]) throw new Error("archives 目录中没有可验证的备份");
  return candidates[0].path;
}

async function main() {
  const archiveDir = resolveStudentTrackArchiveRoot();
  const backupPath = process.argv[2] ? resolve(process.argv[2]) : await latestBackup(archiveDir);
  const manifest = await verifyDatabaseBackup(backupPath);
  console.log(`恢复演练通过: ${backupPath}`);
  console.log(`创建时间: ${manifest.createdAt}`);
  console.log(`学生数: ${manifest.verification.rowCounts.Student}`);
}

main().catch((error) => {
  console.error("恢复演练失败:", error);
  process.exitCode = 1;
});
