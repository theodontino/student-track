import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiarizeEngine } from "@/lib/diarize-tasks";
import type {
  LocalToolAvailability,
  LocalToolCheck,
  LocalToolPreflight,
  LocalToolsStatusResponse,
  LocalToolStatus,
} from "@/lib/local-tool-status";

interface LocalToolStatusOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
}

interface ResolvedFunASRPaths {
  projectRunner: string;
  toolDir: string;
  autoRunner: string;
  localRunner: string;
  tingwuRunner: string;
  aliyunRunner: string;
  venvPython: string;
  hotwords: string;
  dataDir: string;
}

interface ResolvedWccHandoffPaths {
  exchangeRoot: string;
  packages: string;
  receipts: string;
}

const STATUS_PRIORITY: Record<LocalToolAvailability, number> = {
  available: 0,
  warning: 1,
  unavailable: 2,
};

function expandPath(value: string, baseDir: string, homeDir: string) {
  const expanded = value === "~"
    ? homeDir
    : value.startsWith("~/")
      ? path.join(homeDir, value.slice(2))
      : value;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

function resolveOverride(
  value: string | undefined,
  fallback: string,
  baseDir: string,
  homeDir: string,
) {
  return value?.trim() ? expandPath(value.trim(), baseDir, homeDir) : fallback;
}

export function resolveFunASRPaths(options: LocalToolStatusOptions = {}): ResolvedFunASRPaths {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const defaultToolDir = path.join(homeDir, "tools", "funasr-diarize");
  const toolDir = resolveOverride(
    env.STUDENT_TRACK_DIARIZE_TOOL_DIR ?? env.CHEM_TRACK_DIARIZE_TOOL_DIR,
    defaultToolDir,
    cwd,
    homeDir,
  );
  const defaultVenv = path.join(homeDir, "tools", "funasr-diarize", "venv");

  return {
    projectRunner: path.join(cwd, "diarize.sh"),
    toolDir,
    autoRunner: path.join(toolDir, "diarize_auto.sh"),
    localRunner: path.join(toolDir, "diarize.sh"),
    tingwuRunner: path.join(toolDir, "diarize_tingwu.sh"),
    aliyunRunner: path.join(toolDir, "diarize_aliyun.sh"),
    venvPython: path.join(resolveOverride(env.FUNASR_VENV, defaultVenv, cwd, homeDir), "bin", "python"),
    hotwords: resolveOverride(
      env.STUDENT_TRACK_BASE_HOTWORDS ?? env.CHEM_TRACK_BASE_HOTWORDS,
      path.join(toolDir, "hotwords_active.txt"),
      cwd,
      homeDir,
    ),
    dataDir: resolveOverride(env.DIARIZE_DATA_DIR, path.join(cwd, "data", "diarize"), cwd, homeDir),
  };
}

export function resolveWccHandoffPaths(options: LocalToolStatusOptions = {}): ResolvedWccHandoffPaths {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const exchangeRoot = resolveOverride(
    env.STUDENT_TRACK_WCC_EXCHANGE_ROOT,
    path.join(homeDir, "Library", "Application Support", "WCC Student Track Exchange"),
    cwd,
    homeDir,
  );

  return {
    exchangeRoot,
    packages: path.join(exchangeRoot, "v1", "packages"),
    receipts: path.join(exchangeRoot, "v1", "receipts"),
  };
}

function canAccess(targetPath: string, mode: number) {
  try {
    fs.accessSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function isFile(targetPath: string) {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(targetPath: string) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function readableFile(targetPath: string) {
  return isFile(targetPath) && canAccess(targetPath, fs.constants.R_OK);
}

function executableFile(targetPath: string) {
  return isFile(targetPath) && canAccess(targetPath, fs.constants.X_OK);
}

function readableDirectory(targetPath: string) {
  return isDirectory(targetPath) && canAccess(targetPath, fs.constants.R_OK | fs.constants.X_OK);
}

function nearestExistingDirectory(targetPath: string) {
  let candidate = targetPath;
  while (!isDirectory(candidate)) {
    if (fs.existsSync(candidate)) return null;
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}

function dataDirectoryReady(targetPath: string) {
  if (isDirectory(targetPath)) {
    return canAccess(targetPath, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  }
  const parent = nearestExistingDirectory(path.dirname(targetPath));
  return Boolean(parent && canAccess(parent, fs.constants.W_OK | fs.constants.X_OK));
}

function findExecutable(command: string, env: Readonly<Record<string, string | undefined>>, cwd: string) {
  if (command.includes(path.sep)) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return executableFile(candidate) ? candidate : null;
  }

  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(entry || cwd, command);
    if (executableFile(candidate)) return candidate;
  }
  return null;
}

function check(
  id: string,
  label: string,
  status: LocalToolAvailability,
  detail: string,
  targetPath?: string,
): LocalToolCheck {
  return { id, label, status, detail, ...(targetPath ? { path: targetPath } : {}) };
}

function overallStatus(checks: LocalToolCheck[]): LocalToolAvailability {
  return checks.reduce<LocalToolAvailability>(
    (current, item) => STATUS_PRIORITY[item.status] > STATUS_PRIORITY[current] ? item.status : current,
    "available",
  );
}

function summaryFor(status: LocalToolAvailability) {
  if (status === "available") return "静态检查通过";
  if (status === "warning") return "可运行，但有项目需要留意";
  return "缺少必要的本地依赖";
}

export function inspectFunASR(options: LocalToolStatusOptions = {}): LocalToolStatus {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const paths = resolveFunASRPaths(options);
  const ffmpeg = findExecutable("ffmpeg", env, cwd);
  const ffprobe = findExecutable("ffprobe", env, cwd);
  const dataDirExists = isDirectory(paths.dataDir);
  const checks: LocalToolCheck[] = [
    check(
      "project-runner",
      "项目转写入口",
      executableFile(paths.projectRunner) ? "available" : "unavailable",
      executableFile(paths.projectRunner) ? "入口可执行" : "缺少可执行的 diarize.sh",
      paths.projectRunner,
    ),
    check(
      "tool-directory",
      "FunASR 工具目录",
      readableDirectory(paths.toolDir) ? "available" : "unavailable",
      readableDirectory(paths.toolDir) ? "目录可读取" : "目录不存在或不可读取",
      paths.toolDir,
    ),
    check(
      "auto-runner",
      "自动转写入口",
      executableFile(paths.autoRunner) ? "available" : "unavailable",
      executableFile(paths.autoRunner) ? "入口可执行" : "auto 模式入口不存在或不可执行",
      paths.autoRunner,
    ),
    check(
      "local-runner",
      "本地转写入口",
      executableFile(paths.localRunner) ? "available" : "warning",
      executableFile(paths.localRunner) ? "入口可执行" : "local 模式入口不存在或不可执行",
      paths.localRunner,
    ),
    check(
      "tingwu-runner",
      "通义听悟入口",
      executableFile(paths.tingwuRunner) ? "available" : "warning",
      executableFile(paths.tingwuRunner) ? "入口可执行" : "tingwu 模式入口不存在或不可执行",
      paths.tingwuRunner,
    ),
    check(
      "aliyun-runner",
      "阿里云 ASR 入口",
      executableFile(paths.aliyunRunner) ? "available" : "warning",
      executableFile(paths.aliyunRunner) ? "入口可执行" : "阿里云回退入口不存在或不可执行",
      paths.aliyunRunner,
    ),
    check(
      "venv-python",
      "本地 Python 环境",
      executableFile(paths.venvPython) ? "available" : "warning",
      executableFile(paths.venvPython) ? "虚拟环境 Python 可执行" : "本地模式所需 Python 不存在或不可执行",
      paths.venvPython,
    ),
    check(
      "ffmpeg",
      "ffmpeg",
      ffmpeg ? "available" : "warning",
      ffmpeg ? "命令可执行" : "PATH 中未找到 ffmpeg",
      ffmpeg ?? undefined,
    ),
    check(
      "ffprobe",
      "ffprobe",
      ffprobe ? "available" : "warning",
      ffprobe ? "命令可执行" : "PATH 中未找到 ffprobe",
      ffprobe ?? undefined,
    ),
    check(
      "base-hotwords",
      "基础热词",
      readableFile(paths.hotwords) ? "available" : "warning",
      readableFile(paths.hotwords) ? "热词文件可读取" : "未找到基础热词；仍可使用学生姓名热词",
      paths.hotwords,
    ),
    check(
      "data-directory",
      "转写数据目录",
      dataDirectoryReady(paths.dataDir) ? "available" : "unavailable",
      dataDirectoryReady(paths.dataDir)
        ? dataDirExists ? "目录可写" : "目录尚未创建，父目录可写"
        : "目录不可写且无法安全创建",
      paths.dataDir,
    ),
  ];
  const status = overallStatus(checks);

  return {
    id: "funasr",
    name: "音频转写 / FunASR",
    status,
    summary: summaryFor(status),
    checks,
    notice: "auto 模式会依次尝试通义听悟、本地 FunASR 和阿里云 ASR；音频可能上传到云端服务。",
  };
}

export function inspectWccHandoff(options: LocalToolStatusOptions = {}): LocalToolStatus {
  const paths = resolveWccHandoffPaths(options);
  const env = options.env ?? process.env;
  const checks: LocalToolCheck[] = [
    check(
      "exchange-root",
      "handoff 交换目录",
      dataDirectoryReady(paths.exchangeRoot) ? "available" : "unavailable",
      dataDirectoryReady(paths.exchangeRoot) ? "目录可读写或可安全创建" : "目录不可读写",
      paths.exchangeRoot,
    ),
    check(
      "packages",
      "handoff 包目录",
      isDirectory(paths.packages) ? readableDirectory(paths.packages) ? "available" : "unavailable" : "warning",
      isDirectory(paths.packages) ? "目录可读取" : "尚无已投递包",
      paths.packages,
    ),
    check(
      "receipts",
      "handoff 回执目录",
      dataDirectoryReady(paths.receipts) ? "available" : "unavailable",
      dataDirectoryReady(paths.receipts) ? "目录可读写或可安全创建" : "目录不可读写",
      paths.receipts,
    ),
    check(
      "directory-api-token",
      "只读花名册 API",
      env.WECOMCATCH_API_TOKEN?.trim() ? "available" : "warning",
      env.WECOMCATCH_API_TOKEN?.trim() ? "认证 Token 已配置；不会显示其内容" : "未配置目录 API Token",
    ),
  ];
  const status = overallStatus(checks);

  return {
    id: "wecomcatch",
    name: "WCC handoff",
    status,
    summary: summaryFor(status),
    checks,
    notice: "这里只检查交换目录和 ST 自身的只读花名册 API 配置；不会检查、读取或启动 WCC runtime。",
  };
}

export function getLocalToolsStatus(options: LocalToolStatusOptions = {}): LocalToolsStatusResponse {
  return {
    checkedAt: new Date().toISOString(),
    tools: [inspectFunASR(options), inspectWccHandoff(options)],
  };
}

export function preflightDiarize(
  engine: DiarizeEngine,
  options: LocalToolStatusOptions = {},
): LocalToolPreflight {
  const paths = resolveFunASRPaths(options);
  const blockers: string[] = [];
  const engineRunner = engine === "auto"
    ? paths.autoRunner
    : engine === "local"
      ? paths.localRunner
      : paths.tingwuRunner;

  if (!executableFile(paths.projectRunner)) blockers.push("项目转写入口 diarize.sh 不存在或不可执行");
  if (!readableDirectory(paths.toolDir)) blockers.push("FunASR 工具目录不存在或不可读取");
  if (!executableFile(engineRunner)) blockers.push(`${engine} 模式入口不存在或不可执行`);
  if (engine === "local" && !executableFile(paths.venvPython)) {
    blockers.push("local 模式所需虚拟环境 Python 不存在或不可执行");
  }
  if (!dataDirectoryReady(paths.dataDir)) blockers.push("转写数据目录不可写且无法安全创建");

  return { ready: blockers.length === 0, blockers };
}
