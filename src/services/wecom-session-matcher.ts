import type { PrismaClient } from "@/generated/prisma/client";

/**
 * 通过日期 + 班级匹配课次的小工具。
 * 设计前提：ClassSession.code 格式 YYYYMMDDNN，date 与 code 1:1 对应；
 * 同一班级同一天通常只有 1 节课（NN=01），少数情况下 1 天多节。
 *
 * 调用方按"先取最早一节"或"取唯一一节"语义使用，避免 LLM 介入选课次。
 */

export interface SessionByDateAndClass {
  classId: string;
  date: string; // YYYY-MM-DD
}

export interface SessionInRangeAndClass {
  classId: string;
  fromDate: string; // YYYY-MM-DD（含）
  toDate: string; // YYYY-MM-DD（含）
}

/**
 * 查"指定班级 + 指定日期"的课次 code。同一天该班级有 1~N 节课时取最早一节
 * （按 `code` 字典序最小，即 NN=01 排在前）；没课次返回 null。
 */
export async function findSessionByDateAndClass(
  prisma: PrismaClient,
  query: SessionByDateAndClass,
): Promise<string | null> {
  const session = await prisma.classSession.findFirst({
    where: { classId: query.classId, date: query.date, semester: { deletedAt: null }, class: { deletedAt: null } },
    // date asc + code asc：date asc 处理跨日，code asc 解决同日多节时稳定取第一节。
    orderBy: [{ date: "asc" }, { code: "asc" }],
    select: { code: true },
  });
  return session?.code ?? null;
}

/**
 * 批量查"指定班级在 [fromDate, toDate] 范围内"的最早一节课 code。
 * 返回 classId → code 的 Map，调用方用 `map.get(classId)` 取某班的命中结果。
 *
 * 已按 `date asc, code asc` 排序，每个 classId 首次出现的 code 即为该班范围内
 * 最早一节；同日多节时 NN 较小的（早排）会被优先选中。
 */
export async function buildClassEarliestSessionMap(
  prisma: PrismaClient,
  range: { fromDate: string; toDate: string },
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (range.fromDate > range.toDate) return result;
  const sessions = await prisma.classSession.findMany({
    where: {
      date: { gte: range.fromDate, lte: range.toDate },
      classId: { not: null },
      semester: { deletedAt: null },
      class: { deletedAt: null },
    },
    select: { code: true, classId: true, date: true },
    orderBy: [{ date: "asc" }, { code: "asc" }],
  });
  for (const session of sessions) {
    if (!session.classId) continue;
    if (!result.has(session.classId)) {
      result.set(session.classId, session.code);
    }
  }
  return result;
}

/**
 * 在已加载的课次列表中，按指定 `date` 筛出当日第一节课 code。
 * 调用方通常是前端缓存了 `item.sessions`，需要从消息 `occurredAt.min` 反查。
 * 没匹配到返回 `null`；同日多节时按 `code` 字典序最小取 NN=01。
 */
export function findFirstSessionOnDateInList<
  T extends { code: string; date: string },
>(
  sessions: readonly T[],
  date: string,
): string | null {
  let best: T | null = null;
  for (const session of sessions) {
    if (session.date !== date) continue;
    if (!best || session.code < best.code) best = session;
  }
  return best?.code ?? null;
}

/**
 * 计算两个 `YYYY-MM-DD` 字符串之间的整天数差（`to - from`，可负）。
 * 输入必须为合法的日历日期字符串（不校验完整性，依赖上游保证）。
 * 不区分时区，纯粹按日历日计算。
 */
export function dayDelta(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.POSITIVE_INFINITY;
  return Math.round((to - from) / 86_400_000);
}

/**
 * 在已加载的课次列表中，按 `anchorDate`（消息最早日）锚点选"最近一节"。
 * 距离相同时取较早的一节（`date asc, code asc`）；空列表返回 `null`。
 *
 * 排序键：
 * 1. `abs(session.date - anchorDate)` 升序（距离近的优先）
 * 2. `session.date` 升序（同距高取早的）
 * 3. `session.code` 升序（同距同日多节时稳定取 NN=01）
 */
export function findNearestSessionByDateInList<
  T extends { code: string; date: string },
>(
  sessions: readonly T[],
  anchorDate: string,
): string | null {
  if (sessions.length === 0) return null;
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const session of sessions) {
    const distance = Math.abs(dayDelta(anchorDate, session.date));
    if (distance > bestDistance) continue;
    const sameDistance = distance === bestDistance;
    const isBetter = !best
      || distance < bestDistance
      || (sameDistance && (session.date < best.date
        || (session.date === best.date && session.code < best.code)));
    if (isBetter) {
      best = session;
      bestDistance = distance;
    }
  }
  return best?.code ?? null;
}

/**
 * 默认锚点匹配距离上限（天）。超过这个距离视为"过远"，调用方决定是
 * 拒绝还是转人工。改这个值需要同步改协议和测试。
 */
export const DEFAULT_MAX_NEAREST_DISTANCE_DAYS = 30;

/**
 * 批量查"以 `anchorDate` 为锚点，距其最近一节课"按 classId 索引的 Map。
 * 调用方对每个班级 `map.get(classId)` 即可拿到该班匹配到的那节。
 *
 * 默认搜索范围：同学期（用 `semesterId` 限定）。`searchAllSemesters` 为 true
 * 时跨学期搜（兜底历史数据）。`maxDistanceDays` 限定距离上限（默认 30 天），
 * 超过上限视为"该班无法匹配"，map 中不会包含该 classId。
 */
export async function buildClassNearestSessionMap(
  prisma: PrismaClient,
  args: {
    anchorDate: string;
    semesterId?: string;
    searchAllSemesters?: boolean;
    maxDistanceDays?: number;
  },
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!args.anchorDate) return result;
  const maxDistance = args.maxDistanceDays ?? DEFAULT_MAX_NEAREST_DISTANCE_DAYS;
  const sessions = await prisma.classSession.findMany({
    where: {
      classId: { not: null },
      semester: { deletedAt: null },
      class: { deletedAt: null },
      ...(args.searchAllSemesters || !args.semesterId ? {} : { semesterId: args.semesterId }),
    },
    select: { code: true, classId: true, date: true },
  });
  // 按 classId 分组后逐个找最近一节。
  const grouped = new Map<string, Array<{ code: string; date: string }>>();
  for (const session of sessions) {
    if (!session.classId) continue;
    const list = grouped.get(session.classId);
    if (list) list.push({ code: session.code, date: session.date });
    else grouped.set(session.classId, [{ code: session.code, date: session.date }]);
  }
  for (const [classId, list] of grouped) {
    const nearest = pickNearestWithinDistance(list, args.anchorDate, maxDistance);
    if (nearest) result.set(classId, nearest);
  }
  return result;
}

/**
 * 在已加载的课次列表中按 anchorDate 取最近一节，超过 maxDistanceDays 返回 null。
 * 排序键与 `findNearestSessionByDateInList` 一致：近的优先、同距取早。
 * 单独抽出来便于上层（含 UI 按钮）复用同样的语义。
 */
export function pickNearestWithinDistance<
  T extends { code: string; date: string },
>(
  sessions: readonly T[],
  anchorDate: string,
  maxDistanceDays: number,
): string | null {
  if (sessions.length === 0) return null;
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const session of sessions) {
    const distance = Math.abs(dayDelta(anchorDate, session.date));
    if (distance > bestDistance) continue;
    const sameDistance = distance === bestDistance;
    const isBetter = !best
      || distance < bestDistance
      || (sameDistance && (session.date < best.date
        || (session.date === best.date && session.code < best.code)));
    if (isBetter) {
      best = session;
      bestDistance = distance;
    }
  }
  if (!best || bestDistance > maxDistanceDays) return null;
  return best.code;
}

/**
 * 把消息 sentAt 数组归一成 { min, max } YYYY-MM-DD 范围。
 * 全部消息无 sentAt 时返回 null。
 */
export function summarizeMessageDateRange(
  sentAtValues: Array<string | null | undefined>,
): { min: string; max: string } | null {
  const dates = sentAtValues
    .map(shanghaiCalendarDate)
    .filter((value): value is string => value !== null)
    .sort();
  if (dates.length === 0) return null;
  return { min: dates[0], max: dates.at(-1)! };
}

/**
 * 企业微信时间以中国教学日历解释。不能用 toISOString()，否则凌晨消息会被
 * 换算到前一天，进而错误绑定课次。非法时间只返回 null，由调用方走人工处理。
 */
export function shanghaiCalendarDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}
