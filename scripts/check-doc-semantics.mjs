import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

async function read(path) {
  return readFile(resolve(root, path), "utf8");
}

function fail(message) {
  errors.push(message);
}

function expectMatch(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) {
    fail(`${label}：未找到可检查的当前版本声明`);
    return undefined;
  }
  return match[1]?.trim();
}

const packageJson = JSON.parse(await read("package.json"));
const packageLock = JSON.parse(await read("package-lock.json"));
const version = packageJson.version;

if (typeof version !== "string" || version.length === 0) {
  fail("package.json：version 缺失");
}

const lockRootVersion = packageLock.packages?.[""]?.version;
if (packageLock.version !== version) {
  fail(`package-lock.json：顶层 version=${packageLock.version ?? "<missing>"}，应为 ${version}`);
}
if (lockRootVersion !== version) {
  fail(`package-lock.json：packages[\"\"].version=${lockRootVersion ?? "<missing>"}，应为 ${version}`);
}

const rootReadme = await read("README.md");
const readmeVersion = expectMatch(
  rootReadme,
  /当前开发版本为\s*\*\*([^*]+)\*\*/,
  "README.md",
);
if (readmeVersion && readmeVersion !== version) {
  fail(`README.md：当前开发版本=${readmeVersion}，package.json=${version}`);
}

const releases = await read("docs/RELEASES.md");
const releasesVersion = expectMatch(
  releases,
  /^\|\s*Student Track\s*\|\s*([^|]+?)\s*\|/m,
  "docs/RELEASES.md",
);
if (releasesVersion && releasesVersion !== version) {
  fail(`docs/RELEASES.md：当前 Student Track 版本=${releasesVersion}，package.json=${version}`);
}

const evidencePath = `docs/release-evidence/${version}.md`;
let evidence;
try {
  evidence = await read(evidencePath);
} catch {
  fail(`${evidencePath}：当前产品版本缺少 release evidence`);
}
if (evidence) {
  const evidenceVersion = expectMatch(
    evidence,
    /^- Student Track version:\s*(.+)$/m,
    evidencePath,
  );
  if (evidenceVersion && evidenceVersion !== version) {
    fail(`${evidencePath}：Student Track version=${evidenceVersion}，package.json=${version}`);
  }
}

const docsIndex = await read("docs/README.md");
const docsEntries = await readdir(resolve(root, "docs"), { withFileTypes: true });
for (const entry of docsEntries) {
  if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
  if (!docsIndex.includes(`(${entry.name})`)) {
    fail(`docs/README.md：未登记顶层长期文档 docs/${entry.name}`);
  }
}

const productVersioning = await read("docs/PRODUCT_VERSIONING.md");
if (/^##\s*当前基线\s*$/m.test(productVersioning)) {
  fail("docs/PRODUCT_VERSIONING.md：不得维护独立的“当前基线”版本副本");
}

const handoff = await read("docs/WECOM_FILE_HANDOFF.md");
if (/当前稳定配对/.test(handoff)) {
  fail("docs/WECOM_FILE_HANDOFF.md：ST 适配说明不得维护产品配对版本");
}
if (/student-track-wcg-protocols/.test(handoff)) {
  fail("docs/WECOM_FILE_HANDOFF.md：仍引用已废弃的 WCG 协议仓库名");
}

const agents = await read("AGENTS.md");
const contractReadme = await read("docs/contracts/README.md");
for (const [path, source] of [
  ["AGENTS.md", agents],
  ["docs/contracts/README.md", contractReadme],
]) {
  if (/student-track-wcg-protocols/.test(source)) {
    fail(`${path}：仍引用已废弃的 WCG 协议仓库名`);
  }
  if (!/protocol-st-wcg/.test(source)) {
    fail(`${path}：未声明当前 WCG canonical 协议仓库 protocol-st-wcg`);
  }
}

if (errors.length > 0) {
  console.error("文档语义检查失败：");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`文档语义检查通过：产品版本 ${version}，长期文档与当前事实来源一致。`);
