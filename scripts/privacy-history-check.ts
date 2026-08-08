import { execFileSync, spawnSync } from "node:child_process";
import { privacyFindings } from "./privacy-rules";

interface HistoricalEntry {
  objectId: string;
  path: string;
}

interface Finding {
  objectId: string;
  path: string;
  rule: string;
}

const entries = execFileSync("git", ["rev-list", "--objects", "--all"], {
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
}).trim().split("\n").flatMap((line): HistoricalEntry[] => {
  const separator = line.indexOf(" ");
  return separator > 0 ? [{ objectId: line.slice(0, separator), path: line.slice(separator + 1) }] : [];
});

const objectIds = [...new Set(entries.map((entry) => entry.objectId))];
const objectInfo = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
  input: `${objectIds.join("\n")}\n`,
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
});
if (objectInfo.status !== 0) throw new Error("无法读取 Git 历史对象清单");

const eligibleBlobIds = new Set(objectInfo.stdout.trim().split("\n").flatMap((line) => {
  const [objectId, type, size] = line.split(" ");
  return type === "blob" && Number(size) <= 2_000_000 ? [objectId] : [];
}));

function readBlobBatch(ids: string[]) {
  const result = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const batch = spawnSync("git", ["cat-file", "--batch"], {
      input: Buffer.from(`${chunk.join("\n")}\n`),
      maxBuffer: 250 * 1024 * 1024,
    });
    if (batch.status !== 0 || !batch.stdout) throw new Error("无法读取 Git 历史 blob");
    const output = batch.stdout;
    let cursor = 0;
    for (const expectedId of chunk) {
      const headerEnd = output.indexOf(0x0a, cursor);
      if (headerEnd < 0) throw new Error("Git 历史 blob 响应不完整");
      const [objectId, type, sizeText] = output.subarray(cursor, headerEnd).toString("utf8").split(" ");
      const size = Number(sizeText);
      if (objectId !== expectedId || type !== "blob" || !Number.isFinite(size)) throw new Error("Git 历史 blob 响应无效");
      const contentStart = headerEnd + 1;
      result.set(objectId, output.subarray(contentStart, contentStart + size).toString("utf8"));
      cursor = contentStart + size + 1;
    }
  }
  return result;
}

const blobContents = readBlobBatch([...eligibleBlobIds]);
const findings: Finding[] = [];
for (const entry of entries) {
  const content = blobContents.get(entry.objectId);
  for (const rule of privacyFindings(entry.path, content)) {
    findings.push({ objectId: entry.objectId.slice(0, 12), path: entry.path, rule });
  }
}

const uniqueFindings = [...new Map(findings.map((finding) => [
  `${finding.objectId}\0${finding.path}\0${finding.rule}`,
  finding,
])).values()];
if (uniqueFindings.length > 0) {
  console.error("Git 历史隐私检查失败：");
  for (const finding of uniqueFindings) {
    console.error(`- ${finding.objectId} ${finding.path}: ${finding.rule}`);
  }
  process.exit(1);
}

console.log(`Git 历史隐私检查通过：已检查 ${entries.length} 个历史路径、${eligibleBlobIds.size} 个文本 blob。`);
