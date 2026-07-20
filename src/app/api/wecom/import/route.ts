import { NextRequest, NextResponse } from "next/server";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { prisma } from "@/lib/prisma";
import {
  applyWeComCommunicationImport,
  planWeComCommunicationImport,
} from "@/services/wecom-import-service";

interface CandidatePath {
  path: string;
  modifiedAt: string;
}

async function collectJsonCandidates(root: string, maxDepth = 4): Promise<CandidatePath[]> {
  const results: CandidatePath[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      if (!entry.name.includes("chemtrack-bridge")) continue;
      const fileStat = await stat(fullPath);
      results.push({ path: fullPath, modifiedAt: fileStat.mtime.toISOString() });
    }
  }

  await walk(root, 0);
  return results;
}

export async function GET() {
  const home = process.env.HOME || homedir();
  const roots = [
    join(home, ".openclaw/workspace/work/active"),
    join(home, ".openclaw/workspace/output"),
  ];
  const candidates = (await Promise.all(roots.map((root) => collectJsonCandidates(root))))
    .flat()
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, 8);
  return NextResponse.json({
    suggestedPath: candidates[0]?.path ?? "",
    candidates,
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      jsonPath?: string;
      jsonText?: string;
      apply?: boolean;
      includeMedium?: boolean;
      skipBackup?: boolean;
    };
    const input = {
      jsonPath: body.jsonPath,
      jsonText: body.jsonText,
      includeMedium: body.includeMedium === true,
      skipBackup: body.skipBackup === true,
    };
    const result = body.apply
      ? await applyWeComCommunicationImport(prisma, input)
      : await planWeComCommunicationImport(prisma, input);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error && error.message.startsWith("缺少")
      ? error.message
      : "企微候选校验或导入失败，数据库未完成写入";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
