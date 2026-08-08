import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { privacyFindings } from "./privacy-rules";

interface Finding { path: string; rule: string; }

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const findings: Finding[] = [];
for (const path of tracked) {
  let stat;
  try { stat = statSync(path); } catch { /* untracked file may disappear during inspection */ }
  const content = stat?.isFile() && stat.size <= 2_000_000 ? readFileSync(path, "utf8") : undefined;
  for (const rule of privacyFindings(path, content)) findings.push({ path, rule });
}

if (findings.length) {
  console.error("隐私检查失败：");
  for (const finding of findings) console.error(`- ${finding.path}: ${finding.rule}`);
  process.exit(1);
}
console.log(`隐私检查通过：已检查 ${tracked.length} 个 Git 跟踪文件。`);
