import { resolve } from "node:path";

export function sqliteFileUrl(filePath: string) {
  const absolutePath = resolve(filePath).replaceAll("\\", "/");
  return `file:${absolutePath}`;
}
