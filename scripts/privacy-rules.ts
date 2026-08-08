import { basename } from "node:path";

export const forbiddenPrivacyNames = [
  /(^|\/)\.env$/,
  /\.(db|sqlite|sqlite3)$/i,
  /(^|\/)(archives|runtime|data|exports|diagnostics|local-backups)\//i,
  /(^|\/)config\.local\.json$/i,
  /(^|\/)\.DS_Store$/,
  /\.(pem|p12|pfx)$/i,
];

const slash = "/";
export const privacyContentRules: Array<[string, RegExp]> = [
  ["personal macOS home path", new RegExp(`${slash}Users${slash}(?!username(?:${slash}|$)|example(?:${slash}|$)|your-name(?:${slash}|$))[A-Za-z0-9._-]+${slash}`)],
  ["personal Linux home path", new RegExp(`${slash}home${slash}(?!username(?:${slash}|$)|example(?:${slash}|$)|your-name(?:${slash}|$))[A-Za-z0-9._-]+${slash}`)],
  ["private key", new RegExp(["-----BEGIN ", "PRIVATE KEY-----"].join("(?:RSA |EC |OPENSSH )?"))],
  ["GitHub token", new RegExp(["gh", "p_[A-Za-z0-9]{20,}"].join(""))],
  ["GitHub fine-grained token", new RegExp(["github", "_pat_[A-Za-z0-9_]{20,}"].join(""))],
  ["OpenAI-style key", new RegExp(`\\b${["s", "k-"].join("")}[A-Za-z0-9_-]{20,}\\b`)],
  ["AWS access key", new RegExp(`\\b${["AK", "IA"].join("")}[0-9A-Z]{16}\\b`)],
  ["mainland China phone-like value", /\b1[3-9][0-9]{9}\b/],
];

export function privacyFindings(path: string, content?: string) {
  const findings: string[] = [];
  for (const pattern of forbiddenPrivacyNames) {
    if (pattern.test(path)) findings.push("forbidden tracked artifact");
  }
  if (content === undefined) return findings;

  for (const [rule, pattern] of privacyContentRules) {
    if (path === ".env.example" && rule === "OpenAI-style key") continue;
    if (pattern.test(content)) findings.push(rule);
  }
  if (/HANDOFF|交接/.test(basename(path)) && /运行状态|current status|当前数据库状态/i.test(content)) {
    findings.push("runtime handoff document");
  }
  return findings;
}
