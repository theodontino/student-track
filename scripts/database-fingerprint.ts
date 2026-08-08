import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export type FileFingerprint =
  | { exists: false }
  | { exists: true; sizeBytes: string; mtimeNs: string; sha256: string };

export interface DatabaseFileFingerprint {
  database: FileFingerprint;
  wal: FileFingerprint;
}

async function sha256(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileFingerprint(filePath: string): Promise<FileFingerprint> {
  let before;
  try {
    before = await stat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }

  const digest = await sha256(filePath);
  const after = await stat(filePath, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new Error("数据库文件在生成验证指纹期间发生变化；请停止业务写入后重试");
  }

  return {
    exists: true,
    sizeBytes: after.size.toString(),
    mtimeNs: after.mtimeNs.toString(),
    sha256: digest,
  };
}

export async function fingerprintDatabaseFiles(databasePath: string): Promise<DatabaseFileFingerprint> {
  return {
    database: await fileFingerprint(databasePath),
    wal: await fileFingerprint(`${databasePath}-wal`),
  };
}

export function assertDatabaseFingerprintUnchanged(
  before: DatabaseFileFingerprint,
  after: DatabaseFileFingerprint,
) {
  for (const key of ["database", "wal"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new Error(`真实数据库${key === "wal" ? " WAL" : "主文件"}的 size、mtime 或 SHA-256 发生变化`);
    }
  }
}
