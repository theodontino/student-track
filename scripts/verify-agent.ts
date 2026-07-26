import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

type VerificationMode = "quick" | "quality" | "browser" | "release";

type VerificationStep = {
  name: string;
  args: string[];
};

type StepResult = {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  log: string;
  summary: string;
};

const requestedMode = process.argv[2];
const plans: Record<VerificationMode, VerificationStep[]> = {
  quick: [
    { name: "lint", args: ["run", "lint"] },
    { name: "typecheck", args: ["run", "typecheck"] },
    { name: "unit-tests", args: ["test", "--", "--reporter=dot"] },
  ],
  quality: [
    { name: "lint", args: ["run", "lint"] },
    { name: "typecheck", args: ["run", "typecheck"] },
    { name: "docs-check", args: ["run", "docs:check"] },
    { name: "docs-links", args: ["run", "docs:links"] },
    { name: "privacy-check", args: ["run", "privacy:check"] },
    { name: "coverage", args: ["run", "test:coverage"] },
    { name: "build", args: ["run", "build"] },
  ],
  browser: [
    { name: "browser-e2e", args: ["run", "test:e2e"] },
  ],
  release: [
    { name: "lint", args: ["run", "lint"] },
    { name: "typecheck", args: ["run", "typecheck"] },
    { name: "docs-check", args: ["run", "docs:check"] },
    { name: "docs-links", args: ["run", "docs:links"] },
    { name: "privacy-check", args: ["run", "privacy:check"] },
    { name: "coverage", args: ["run", "test:coverage"] },
    { name: "build", args: ["run", "build"] },
    { name: "browser-e2e", args: ["run", "test:e2e"] },
  ],
};

function isVerificationMode(value: string | undefined): value is VerificationMode {
  return Boolean(value && Object.hasOwn(plans, value));
}

if (!isVerificationMode(requestedMode)) {
  throw new Error("Usage: verify-agent.ts <quick|quality|browser|release>");
}
const mode = requestedMode;

const projectRoot = process.cwd();
const logRoot = path.join(projectRoot, ".verification-logs");
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${mode}`;
const runDir = path.join(logRoot, runId);
const verbose = process.env.VERIFY_VERBOSE === "1";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const maxCapturedCharacters = 2_000_000;
const failureTailLines = 60;

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function compactMatch(output: string, pattern: RegExp) {
  const match = output.match(pattern);
  return match?.[1]?.trim() ?? "";
}

function summarizeOutput(name: string, rawOutput: string) {
  const output = stripAnsi(rawOutput);
  const parts: string[] = [];
  const testFiles = compactMatch(output, /Test Files\s+([^\n]+)/);
  const tests = compactMatch(output, /\n\s*Tests\s+([^\n]+)/);
  const statements = compactMatch(output, /Statements\s*:\s*([^\n]+)/);
  const buildTime = compactMatch(output, /Compiled successfully in ([^\n]+)/);
  const passedMatches = [...output.matchAll(/^\s*(\d+) passed \(([^)]+)\)$/gm)];

  if (testFiles) parts.push(`files ${testFiles}`);
  if (tests) parts.push(`tests ${tests}`);
  if (statements) parts.push(`statements ${statements}`);
  if (buildTime) parts.push(`compiled ${buildTime}`);
  if (passedMatches.length > 0) {
    parts.push(passedMatches.map((match) => `${match[1]} passed/${match[2]}`).join(", "));
  }

  if (parts.length === 0 && name === "docs-links") {
    const checked = compactMatch(output, /(文档链接检查通过：[^\n]+)/);
    if (checked) parts.push(checked);
  }
  return parts.join("; ");
}

function relativeLogPath(logPath: string) {
  return path.relative(projectRoot, logPath);
}

function runStep(step: VerificationStep): Promise<StepResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const logPath = path.join(runDir, `${step.name}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "wx", mode: 0o600 });
    let captured = "";
    let settled = false;

    console.log(`→ ${step.name}`);
    const child = spawn(npmCommand, step.args, {
      cwd: projectRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    function capture(chunk: Buffer) {
      logStream.write(chunk);
      const text = chunk.toString();
      captured = `${captured}${text}`.slice(-maxCapturedCharacters);
      if (verbose) process.stdout.write(chunk);
    }

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      logStream.end(() => reject(error));
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      logStream.end(() => {
        const status = code === 0 && !signal ? "passed" : "failed";
        resolve({
          name: step.name,
          status,
          durationMs: Date.now() - startedAt,
          log: relativeLogPath(logPath),
          summary: summarizeOutput(step.name, captured),
        });
      });
    });
  });
}

function formatDuration(durationMs: number) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function writeSummary(results: StepResult[], success: boolean) {
  const summaryPath = path.join(runDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    mode,
    success,
    completedAt: new Date().toISOString(),
    steps: results,
  }, null, 2)}\n`, { mode: 0o600 });

  const githubSummary = process.env.GITHUB_STEP_SUMMARY;
  if (githubSummary) {
    const artifactName = process.env.VERIFY_ARTIFACT_NAME ?? ".verification-logs";
    const rows = results.map((result) => (
      `| ${result.status === "passed" ? "✅" : "❌"} | ${result.name} | ${formatDuration(result.durationMs)} | ${result.summary || "—"} |`
    ));
    fs.appendFileSync(githubSummary, [
      `## Verification: ${mode}`,
      "",
      "| 状态 | 步骤 | 耗时 | 摘要 |",
      "| --- | --- | ---: | --- |",
      ...rows,
      "",
      `完整日志：GitHub Actions artifact \`${artifactName}\`，目录 \`${path.basename(runDir)}\``,
      "",
    ].join("\n"));
  }
  return relativeLogPath(summaryPath);
}

async function main() {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const results: StepResult[] = [];

  for (const step of plans[mode]) {
    const result = await runStep(step);
    results.push(result);
    const detail = result.summary ? ` — ${result.summary}` : "";
    console.log(`${result.status === "passed" ? "✓" : "✗"} ${result.name} (${formatDuration(result.durationMs)})${detail}`);
    if (result.status === "failed") {
      const logPath = path.join(projectRoot, result.log);
      const tail = stripAnsi(fs.readFileSync(logPath, "utf8"))
        .trimEnd()
        .split(/\r?\n/)
        .slice(-failureTailLines)
        .join("\n");
      console.error(`\n失败日志末尾（最多 ${failureTailLines} 行）：\n${tail}`);
      console.error(`\n完整日志：${result.log}`);
      console.error(`摘要：${writeSummary(results, false)}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`✓ verification:${mode} (${results.length} steps)`);
  console.log(`摘要：${writeSummary(results, true)}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
