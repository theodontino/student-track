import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface BrokenLink {
  file: string;
  target: string;
}

const markdownFiles = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const brokenLinks: BrokenLink[] = [];
const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;

function localTarget(rawTarget: string) {
  const trimmed = rawTarget.trim();
  const target = trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1)
    : trimmed.split(/\s+/, 1)[0];
  if (!target || target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return null;
  }
  const pathOnly = target.split(/[?#]/, 1)[0];
  if (!pathOnly) return null;
  try {
    return decodeURIComponent(pathOnly);
  } catch {
    return pathOnly;
  }
}

for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(markdownLink)) {
    const target = localTarget(match[1]);
    if (target && !existsSync(resolve(dirname(file), target))) brokenLinks.push({ file, target });
  }
}

if (brokenLinks.length > 0) {
  console.error("文档链接检查失败：");
  for (const link of brokenLinks) console.error(`- ${link.file}: ${link.target}`);
  process.exit(1);
}

console.log(`文档链接检查通过：已检查 ${markdownFiles.length} 个 Markdown 文件。`);
