import { createClient } from "@libsql/client";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { sqliteFileUrl } from "../src/lib/sqlite-file-url";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = resolve(root, "docs/generated");
const checkOnly = process.argv.includes("--check");
const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

interface ColumnInfo {
  name: string;
  type: string;
  required: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

interface ForeignKeyInfo {
  from: string;
  table: string;
  to: string;
}

interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
}

interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function compileSchema(): Promise<TableInfo[]> {
  const prismaCli = resolve(root, "node_modules/prisma/build/index.js");
  const schemaPath = resolve(root, "prisma/schema.prisma");
  const { stdout: sql } = await execFileAsync(process.execPath, [
    prismaCli,
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema",
    schemaPath,
    "--script",
  ], { cwd: root, env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 10 * 1024 * 1024 });

  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "student-track-docs-"));
  const databasePath = resolve(temporaryRoot, "schema.db");
  const client = createClient({ url: sqliteFileUrl(databasePath) });
  try {
    await client.executeMultiple(sql);
    const tableRows = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const tables: TableInfo[] = [];
    for (const tableRow of tableRows.rows) {
      const name = String(tableRow.name);
      const columnsResult = await client.execute(`PRAGMA table_info(${quoteIdentifier(name)})`);
      const foreignKeysResult = await client.execute(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`);
      const indexesResult = await client.execute(`PRAGMA index_list(${quoteIdentifier(name)})`);
      const indexes: IndexInfo[] = [];
      for (const indexRow of indexesResult.rows) {
        const indexName = String(indexRow.name);
        const indexColumns = await client.execute(`PRAGMA index_info(${quoteIdentifier(indexName)})`);
        indexes.push({
          name: indexName,
          unique: Number(indexRow.unique) === 1,
          columns: indexColumns.rows.map((row) => String(row.name)),
        });
      }
      tables.push({
        name,
        columns: columnsResult.rows.map((row) => ({
          name: String(row.name),
          type: String(row.type || "TEXT"),
          required: Number(row.notnull) === 1 || Number(row.pk) > 0,
          primaryKey: Number(row.pk) > 0,
          defaultValue: row.dflt_value === null ? null : String(row.dflt_value),
        })),
        foreignKeys: foreignKeysResult.rows.map((row) => ({
          from: String(row.from),
          table: String(row.table),
          to: String(row.to),
        })),
        indexes,
      });
    }
    return tables;
  } finally {
    client.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function renderSchemaDoc() {
  const tables = await compileSchema();
  const relationships: string[] = [];
  const entities = tables.map((table) => {
    const foreignKeyColumns = new Set(table.foreignKeys.map((foreignKey) => foreignKey.from));
    const singleUniqueColumns = new Set(
      table.indexes.filter((index) => index.unique && index.columns.length === 1).map((index) => index.columns[0]),
    );
    const fields = table.columns.map((column) => {
      const keys = [
        column.primaryKey ? "PK" : "",
        singleUniqueColumns.has(column.name) && !column.primaryKey ? "UK" : "",
        foreignKeyColumns.has(column.name) ? "FK" : "",
      ].filter(Boolean).join(",");
      return `    ${column.type.replaceAll(" ", "_")} ${column.name}${keys ? ` ${keys}` : ""}`;
    }).join("\n");

    for (const foreignKey of table.foreignKeys) {
      const column = table.columns.find((entry) => entry.name === foreignKey.from);
      const targetCardinality = column?.required ? "||" : "o|";
      const sourceIsUnique = table.indexes.some((index) => (
        index.unique && index.columns.length === 1 && index.columns[0] === foreignKey.from
      ));
      relationships.push(
        `  ${foreignKey.table} ${targetCardinality}--${sourceIsUnique ? "o|" : "o{"} ${table.name} : "${foreignKey.from}"`,
      );
    }
    return `  ${table.name} {\n${fields}\n  }`;
  }).join("\n");

  const sections = tables.map((table) => {
    const foreignKeyColumns = new Set(table.foreignKeys.map((foreignKey) => foreignKey.from));
    const singleUniqueColumns = new Set(
      table.indexes.filter((index) => index.unique && index.columns.length === 1).map((index) => index.columns[0]),
    );
    const rows = table.columns.map((column) => {
      const constraints = [
        column.primaryKey ? "PK" : "",
        singleUniqueColumns.has(column.name) && !column.primaryKey ? "unique" : "",
        foreignKeyColumns.has(column.name) ? "FK" : "",
        column.defaultValue !== null ? `default: ${column.defaultValue}` : "",
      ].filter(Boolean).join(", ");
      return `| \`${column.name}\` | \`${column.type}\` | ${column.required ? "是" : "否"} | ${constraints} |`;
    });
    const compoundUnique = table.indexes.filter((index) => index.unique && index.columns.length > 1);
    const indexSummary = compoundUnique.length > 0
      ? `\n复合唯一约束：${compoundUnique.map((index) => `\`${index.columns.join(" + ")}\``).join("、")}。`
      : "";
    return `### ${table.name}\n\n| 字段 | SQLite 类型 | 必填 | 约束 / 默认值 |\n|---|---|---|---|\n${rows.join("\n")}\n${indexSummary}`;
  });

  return `# Schema 与 ER 图\n\n> 自动生成，请勿手动修改。来源：Prisma 编译后的 SQLite Schema。\n\n## ER 图\n\n\`\`\`mermaid\nerDiagram\n${entities}\n${relationships.sort().join("\n")}\n\`\`\`\n\n## 模型字段\n\n${sections.join("\n\n")}\n`;
}

async function findRouteFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findRouteFiles(path);
    return entry.isFile() && entry.name === "route.ts" ? [path] : [];
  }))).flat();
}

function exportedMethods(source: string, fileName: string) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods = new Set<string>();
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name && httpMethods.has(statement.name.text)) {
      methods.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && httpMethods.has(declaration.name.text)) {
          methods.add(declaration.name.text);
        }
      }
    }
  }
  return [...methods].sort();
}

async function renderRoutesDoc() {
  const apiRoot = resolve(root, "src/app/api");
  const files = (await findRouteFiles(apiRoot)).sort();
  const rows = await Promise.all(files.map(async (file) => {
    const source = await readFile(file, "utf8");
    const route = `/api/${relative(apiRoot, dirname(file)).split(sep).join("/")}`.replace(/\/$/, "");
    return `| \`${route}\` | ${exportedMethods(source, file).map((method) => `\`${method}\``).join(", ")} |`;
  }));
  return `# API 路由\n\n> 自动生成，请勿手动修改。来源：\`src/app/api/**/route.ts\`。\n\n| 路由 | 方法 |\n|---|---|\n${rows.join("\n")}\n`;
}

async function syncFile(path: string, content: string) {
  if (checkOnly) {
    const existing = await readFile(path, "utf8").catch(() => "");
    if (existing !== content) throw new Error(`${relative(root, path)} 已过期，请运行 npm run docs:generate`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function main() {
  await syncFile(resolve(generatedDir, "SCHEMA.md"), await renderSchemaDoc());
  await syncFile(resolve(generatedDir, "ROUTES.md"), await renderRoutesDoc());
  console.log(checkOnly ? "生成文档已是最新" : "已生成 docs/generated/SCHEMA.md 和 ROUTES.md");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
