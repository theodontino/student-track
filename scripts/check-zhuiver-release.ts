#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LEVELS = new Set(["PATCH", "MINOR", "MAJOR"]);
const BOOLEAN_FIELDS = ["Product claim changed", "Core workflow changed", "Domain model changed", "Protocol contract changed"];
const REQUIRED_FIELDS = ["Previous Student Track version", "Student Track version", "Zhuiver level", "Zhuiver rationale", ...BOOLEAN_FIELDS, "Protocol issue/tag (if applicable)", "Compatibility records", "Verification evidence"];

function parseFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^- ([^:]+):\s*(.*)$/);
    if (match) fields.set(match[1], match[2].trim());
  }
  return fields;
}

function isPending(value: string | undefined): boolean {
  return !value || value === "TBD" || value === "pending" || value === "TBD | MINOR | MAJOR";
}

const recordPath = process.argv[2];
if (!recordPath) {
  console.error("usage: npm run release:check-version -- <record.md>");
  process.exit(2);
}

const root = resolve(process.cwd());
const path = resolve(root, recordPath);
const fields = parseFields(readFileSync(path, "utf8"));
const errors: string[] = [];
for (const field of REQUIRED_FIELDS) {
  if (isPending(fields.get(field))) errors.push(`missing completed field: ${field}`);
}
const current = fields.get("Student Track version") ?? "";
const previous = fields.get("Previous Student Track version") ?? "";
if (current && !VERSION_RE.test(current)) errors.push(`invalid Student Track version: ${current}`);
if (previous && !VERSION_RE.test(previous)) errors.push(`invalid previous Student Track version: ${previous}`);
if (current && previous && current === previous) errors.push("previous and current Student Track versions must differ");
const level = fields.get("Zhuiver level") ?? "";
if (!LEVELS.has(level)) errors.push(`invalid Zhuiver level: ${level}`);
for (const field of BOOLEAN_FIELDS) {
  const value = fields.get(field);
  if (value && value !== "yes" && value !== "no") errors.push(`${field} must be yes or no`);
}
if (fields.get("Protocol contract changed") === "yes" && isPending(fields.get("Protocol issue/tag (if applicable)"))) {
  errors.push("Protocol issue/tag (if applicable) is required when the contract changed");
}
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: string };
if (current && packageJson.version !== current) errors.push(`record version ${current} does not match package.json ${packageJson.version}`);
const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as {
  version?: string;
  packages?: { "": { version?: string } };
};
if (current && packageLock.version !== current) {
  errors.push(`record version ${current} does not match package-lock.json ${packageLock.version}`);
}
if (current && packageLock.packages?.[""].version !== current) {
  errors.push("package-lock.json root package version does not match the release version");
}
if (errors.length) {
  for (const error of errors) console.error(`zhuiver-check: ${error}`);
  process.exit(1);
}
console.log(`zhuiver-check: ${path} is complete for Student Track ${current} (${level})`);
