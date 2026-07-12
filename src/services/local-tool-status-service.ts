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

interface ResolvedWeComCatchPaths {
  projectRoot: string;
  cli: string;
  runtimeDir: string;
  config: string;
  database: string;
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
  const toolDir = resolveOverride(env.CHEM_TRACK_DIARIZE_TOOL_DIR, defaultToolDir, cwd, homeDir);
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
      env.CHEM_TRACK_BASE_HOTWORDS,
      path.join(toolDir, "hotwords_active.txt"),
      cwd,
      homeDir,
    ),
    dataDir: resolveOverride(env.DIARIZE_DATA_DIR, path.join(cwd, "data", "diarize"), cwd, homeDir),
  };
}

export function resolveWeComCatchPaths(options: LocalToolStatusOptions = {}): ResolvedWeComCatchPaths {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const configuredCli = env.WECOMCATCH_CLI_PATH?.trim()
    ? expandPath(env.WECOMCATCH_CLI_PATH.trim(), cwd, homeDir)
    : null;
  const inferredRoot = configuredCli
    ? path.dirname(path.dirname(configuredCli))
    : path.join(homeDir, "wecomcatch");
  const projectRoot = resolveOverride(env.WECOMCATCH_PROJECT_ROOT, inferredRoot, cwd, homeDir);
  const cli = configuredCli ?? path.join(projectRoot, "bin", "wecomcatch");
  const runtimeDir = resolveOverride(
    env.WECOMCATCH_RUNTIME_DIR,
    path.join(projectRoot, "runtime"),
    projectRoot,
    homeDir,
  );
  const config = resolveOverride(
    env.WECOMCATCH_CONFIG_PATH,
    path.join(projectRoot, "config.local.json"),
    projectRoot,
    homeDir,
  );

  return {
    projectRoot,
    cli,
    runtimeDir,
    config,
    database: path.join(runtimeDir, "archive.sqlite3"),
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

export function inspectWeComCatch(options: LocalToolStatusOptions = {}): LocalToolStatus {
  const paths = resolveWeComCatchPaths(options);
  const runtimeExists = isDirectory(paths.runtimeDir);
  const databaseExists = isFile(paths.database);
  const checks: LocalToolCheck[] = [
    check(
      "cli",
      "WeComCatch CLI",
      executableFile(paths.cli) ? "available" : "unavailable",
      executableFile(paths.cli) ? "CLI 可执行" : "CLI 不存在或不可执行",
      paths.cli,
    ),
    check(
      "runtime-directory",
      "运行数据目录",
      runtimeExists ? readableDirectory(paths.runtimeDir) ? "available" : "unavailable" : "warning",
      runtimeExists
        ? readableDirectory(paths.runtimeDir) ? "目录可读取" : "目录不可读取"
        : "目录尚未创建",
      paths.runtimeDir,
    ),
    check(
      "config",
      "本地配置",
      readableFile(paths.config) ? "available" : "unavailable",
      readableFile(paths.config) ? "配置文件可读取；内容不会由自检接口返回" : "配置文件不存在或不可读取",
      paths.config,
    ),
    check(
      "database",
      "归档数据库",
      databaseExists ? readableFile(paths.database) ? "available" : "unavailable" : "warning",
      databaseExists
        ? readableFile(paths.database) ? "数据库文件可读取；未执行写入或维护命令" : "数据库文件不可读取"
        : "数据库尚未创建",
      paths.database,
    ),
  ];
  const status = overallStatus(checks);

  return {
    id: "wecomcatch",
    name: "WeComCatch",
    status,
    summary: summaryFor(status),
    checks,
    notice: "WeComCatch 是仓库外的可选本地工具；Chem-Track 不包含或分发其源码和运行数据。",
  };
}

export function getLocalToolsStatus(options: LocalToolStatusOptions = {}): LocalToolsStatusResponse {
  return {
    checkedAt: new Date().toISOString(),
    tools: [inspectFunASR(options), inspectWeComCatch(options)],
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

export function preflightWeComCatchSync(options: LocalToolStatusOptions = {}): LocalToolPreflight {
  const paths = resolveWeComCatchPaths(options);
  const blockers: string[] = [];
  if (!executableFile(paths.cli)) blockers.push("WeComCatch CLI 不存在或不可执行");
  if (!readableFile(paths.config)) blockers.push("WeComCatch 本地配置不存在或不可读取");
  return { ready: blockers.length === 0, blockers };
}
