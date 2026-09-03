import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_NEAREST_DISTANCE_DAYS,
  buildClassEarliestSessionMap,
  buildClassNearestSessionMap,
  dayDelta,
  findFirstSessionOnDateInList,
  findNearestSessionByDateInList,
  findSessionByDateAndClass,
  pickNearestWithinDistance,
  shanghaiCalendarDate,
  summarizeMessageDateRange,
} from "@/services/wecom-session-matcher";

function fakePrisma(overrides: {
  classSession?: {
    findFirst?: ReturnType<typeof vi.fn>;
    findMany?: ReturnType<typeof vi.fn>;
  };
}) {
  return {
    classSession: {
      findFirst: overrides.classSession?.findFirst ?? vi.fn(),
      findMany: overrides.classSession?.findMany ?? vi.fn(),
    },
  } as unknown as Parameters<typeof findSessionByDateAndClass>[0];
}

describe("summarizeMessageDateRange", () => {
  it("returns null when no sentAt values are provided", () => {
    expect(summarizeMessageDateRange([])).toBeNull();
    expect(summarizeMessageDateRange([null, undefined, ""])).toBeNull();
  });

  it("ignores empty strings, null and undefined entries", () => {
    expect(summarizeMessageDateRange([
      "2026-06-01T08:00:00Z",
      null,
      "",
      undefined,
      "2026-06-03T10:00:00Z",
    ])).toEqual({ min: "2026-06-01", max: "2026-06-03" });
  });

  it("returns min === max for a single-day batch", () => {
    expect(summarizeMessageDateRange([
      "2026-06-02T12:34:56Z",
      "2026-06-02T00:00:00Z",
    ])).toEqual({ min: "2026-06-02", max: "2026-06-02" });
  });

  it("sorts out-of-order input into ascending min/max", () => {
    expect(summarizeMessageDateRange([
      "2026-06-05T01:00:00Z",
      "2026-06-01T01:00:00Z",
      "2026-06-09T01:00:00Z",
    ])).toEqual({ min: "2026-06-01", max: "2026-06-09" });
  });

  it("uses the Shanghai teaching calendar instead of UTC", () => {
    expect(summarizeMessageDateRange([
      "2026-06-01T15:30:00Z", // 上海时间为 6/1 23:30
      "2026-06-01T16:30:00Z", // 上海时间为 6/2 00:30
    ])).toEqual({ min: "2026-06-01", max: "2026-06-02" });
  });

  it("ignores invalid timestamps instead of aborting the whole batch", () => {
    expect(shanghaiCalendarDate("not-a-timestamp")).toBeNull();
    expect(summarizeMessageDateRange([
      "not-a-timestamp",
      "2026-06-02T12:00:00+08:00",
    ])).toEqual({ min: "2026-06-02", max: "2026-06-02" });
  });
});

describe("findSessionByDateAndClass", () => {
  it("returns the matched session code when one exists", async () => {
    const findFirst = vi.fn().mockResolvedValue({ code: "2026060201" });
    const prisma = fakePrisma({ classSession: { findFirst } });
    const code = await findSessionByDateAndClass(prisma, {
      classId: "class-1",
      date: "2026-06-02",
    });
    expect(code).toBe("2026060201");
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        classId: "class-1",
        date: "2026-06-02",
        semester: { deletedAt: null },
        class: { deletedAt: null },
      },
      orderBy: [{ date: "asc" }, { code: "asc" }],
      select: { code: true },
    });
  });

  it("returns null when no session matches the class+date pair", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = fakePrisma({ classSession: { findFirst } });
    const code = await findSessionByDateAndClass(prisma, {
      classId: "class-empty",
      date: "2026-06-02",
    });
    expect(code).toBeNull();
  });

  it("prefers the lowest code (NN=01) when the same class+date has multiple sessions", async () => {
    // 模拟同日多节：DB 返回两条记录，orderBy 应保证返回 code asc 的最小值。
    const findFirst = vi.fn().mockImplementation(({ orderBy }: { orderBy: Array<Record<string, "asc">> }) => {
      // 模拟 Prisma 按 [date asc, code asc] 排序后取第一条
      const records = [
        { code: "2026060202" },
        { code: "2026060201" },
      ];
      return Promise.resolve(records.sort((a, b) => {
        for (const rule of orderBy) {
          const key = Object.keys(rule)[0] as keyof typeof a;
          if (a[key] < b[key]) return -1;
          if (a[key] > b[key]) return 1;
        }
        return 0;
      })[0]);
    });
    const prisma = fakePrisma({ classSession: { findFirst } });
    const code = await findSessionByDateAndClass(prisma, {
      classId: "class-multi",
      date: "2026-06-02",
    });
    expect(code).toBe("2026060201");
  });
});

describe("buildClassEarliestSessionMap", () => {
  it("returns an empty map when fromDate > toDate", async () => {
    const findMany = vi.fn();
    const prisma = fakePrisma({ classSession: { findMany } });
    const result = await buildClassEarliestSessionMap(prisma, {
      fromDate: "2026-06-10",
      toDate: "2026-06-01",
    });
    expect(result.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("queries classSession with the date range and classId-not-null filter", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({ classSession: { findMany } });
    await buildClassEarliestSessionMap(prisma, {
      fromDate: "2026-06-01",
      toDate: "2026-06-07",
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        date: { gte: "2026-06-01", lte: "2026-06-07" },
        classId: { not: null },
        semester: { deletedAt: null },
        class: { deletedAt: null },
      },
      select: { code: true, classId: true, date: true },
      orderBy: [{ date: "asc" }, { code: "asc" }],
    });
  });

  it("maps each classId to its earliest session within the range", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { code: "2026060201", classId: "class-A", date: "2026-06-02" },
      { code: "2026060401", classId: "class-A", date: "2026-06-04" },
      { code: "2026060301", classId: "class-B", date: "2026-06-03" },
      { code: "2026060501", classId: "class-B", date: "2026-06-05" },
      { code: "2026060601", classId: "class-C", date: "2026-06-06" },
    ]);
    const prisma = fakePrisma({ classSession: { findMany } });
    const result = await buildClassEarliestSessionMap(prisma, {
      fromDate: "2026-06-01",
      toDate: "2026-06-30",
    });
    expect(result.get("class-A")).toBe("2026060201");
    expect(result.get("class-B")).toBe("2026060301");
    expect(result.get("class-C")).toBe("2026060601");
    expect(result.size).toBe(3);
  });

  it("skips sessions whose classId is null", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { code: "2026060201", classId: null, date: "2026-06-02" },
      { code: "2026060301", classId: "class-A", date: "2026-06-03" },
    ]);
    const prisma = fakePrisma({ classSession: { findMany } });
    const result = await buildClassEarliestSessionMap(prisma, {
      fromDate: "2026-06-01",
      toDate: "2026-06-30",
    });
    expect(result.get("class-A")).toBe("2026060301");
    expect(result.size).toBe(1);
  });

  it("returns an empty map when the range contains no sessions", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({ classSession: { findMany } });
    const result = await buildClassEarliestSessionMap(prisma, {
      fromDate: "2026-06-01",
      toDate: "2026-06-07",
    });
    expect(result.size).toBe(0);
  });

  it("picks the lowest code (NN=01) for a class with multiple same-day sessions", async () => {
    // 模拟 SQLite 按 [date asc, code asc] 排序后返回。
    const findMany = vi.fn().mockImplementation(({ orderBy }: { orderBy: Array<Record<string, "asc">> }) => {
      const rows = [
        { code: "2026060201", classId: "class-A", date: "2026-06-02" },
        { code: "2026060202", classId: "class-A", date: "2026-06-02" },
      ];
      return Promise.resolve(rows.sort((a, b) => {
        for (const rule of orderBy) {
          const key = Object.keys(rule)[0] as keyof typeof a;
          if (a[key] < b[key]) return -1;
          if (a[key] > b[key]) return 1;
        }
        return 0;
      }));
    });
    const prisma = fakePrisma({ classSession: { findMany } });
    const result = await buildClassEarliestSessionMap(prisma, {
      fromDate: "2026-06-01",
      toDate: "2026-06-30",
    });
    expect(result.get("class-A")).toBe("2026060201");
  });
});

describe("findFirstSessionOnDateInList", () => {
  const sessions = [
    { code: "2026060501", date: "2026-06-05" },
    { code: "2026060302", date: "2026-06-03" },
    { code: "2026060301", date: "2026-06-03" },
    { code: "2026060201", date: "2026-06-02" },
  ];

  it("returns the lowest code on the target date when same-day multi-sessions exist", () => {
    expect(findFirstSessionOnDateInList(sessions, "2026-06-03")).toBe("2026060301");
  });

  it("returns the only match on the target date when no duplicates", () => {
    expect(findFirstSessionOnDateInList(sessions, "2026-06-02")).toBe("2026060201");
    expect(findFirstSessionOnDateInList(sessions, "2026-06-05")).toBe("2026060501");
  });

  it("returns null when the date has no session", () => {
    expect(findFirstSessionOnDateInList(sessions, "2026-06-10")).toBeNull();
  });

  it("returns null on an empty session list", () => {
    expect(findFirstSessionOnDateInList([], "2026-06-02")).toBeNull();
  });

  it("ignores other dates even when more sessions exist there", () => {
    // 2026-06-03 同日 2 节，但 2026-06-04 一个都没有；应返回 null 而不是相邻日的。
    expect(findFirstSessionOnDateInList(sessions, "2026-06-04")).toBeNull();
  });
});

describe("dayDelta", () => {
  it("returns 0 for the same date", () => {
    expect(dayDelta("2026-06-03", "2026-06-03")).toBe(0);
  });

  it("returns positive for future date, negative for past", () => {
    expect(dayDelta("2026-06-01", "2026-06-08")).toBe(7);
    expect(dayDelta("2026-06-08", "2026-06-01")).toBe(-7);
  });

  it("handles month/year boundary", () => {
    expect(dayDelta("2026-01-30", "2026-02-02")).toBe(3);
    expect(dayDelta("2025-12-30", "2026-01-02")).toBe(3);
  });

  it("returns Infinity when input is invalid", () => {
    expect(dayDelta("not-a-date", "2026-06-01")).toBe(Number.POSITIVE_INFINITY);
    expect(dayDelta("2026-06-01", "not-a-date")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("findNearestSessionByDateInList", () => {
  const sessions = [
    { code: "2026061501", date: "2026-06-15" },
    { code: "2026053001", date: "2026-05-30" },
    { code: "2026060501", date: "2026-06-05" },
    { code: "2026060101", date: "2026-06-01" },
    { code: "2026060301", date: "2026-06-03" },
    { code: "2026060302", date: "2026-06-03" },
  ];

  it("returns the same-day first session when anchorDate has a session", () => {
    expect(findNearestSessionByDateInList(sessions, "2026-06-03")).toBe("2026060301");
  });

  it("picks the closest session by day distance (past preferred over future when equidistant)", () => {
    // 6/3 锚点：6/1 距离 2, 6/5 距离 2 → 同距取早 → 6/1
    expect(findNearestSessionByDateInList(sessions, "2026-06-03")).toBe("2026060301");
    // 6/3 锚点：6/1 距离 2, 6/5 距离 2 → 同距取早 → 6/1
    expect(findNearestSessionByDateInList(
      [{ code: "2026060501", date: "2026-06-05" }, { code: "2026060101", date: "2026-06-01" }],
      "2026-06-03",
    )).toBe("2026060101");
  });

  it("picks the closer side when one side is strictly closer", () => {
    // 6/4 锚点：5/30 距离 5, 6/3 距离 1, 6/5 距离 1 → 同距 6/3 早于 6/5 → 6/3
    expect(findNearestSessionByDateInList(sessions, "2026-06-04")).toBe("2026060301");
    // 6/2 锚点：6/1 距离 1, 6/3 距离 1 → 同距 6/1 早于 6/3 → 6/1
    expect(findNearestSessionByDateInList(sessions, "2026-06-02")).toBe("2026060101");
  });

  it("falls back to a far session when nothing closer exists", () => {
    // 5/15 锚点：5/30 距离 15, 6/1 距离 17 → 5/30
    expect(findNearestSessionByDateInList(sessions, "2026-05-15")).toBe("2026053001");
  });

  it("returns null on an empty list", () => {
    expect(findNearestSessionByDateInList([], "2026-06-03")).toBeNull();
  });
});

describe("buildClassNearestSessionMap", () => {
  it("returns an empty map when anchorDate is empty", async () => {
    const findMany = vi.fn();
    const prisma = fakePrisma({ classSession: { findMany } });
    const result = await buildClassNearestSessionMap(prisma, { anchorDate: "" });
    expect(result.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("queries classSession with the semester filter by default", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({ classSession: { findMany } });
    await buildClassNearestSessionMap(prisma, { anchorDate: "2026-06-03", semesterId: "sem-1" });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        classId: { not: null },
        semester: { deletedAt: null },
        class: { deletedAt: null },
        semesterId: "sem-1",
      },
      select: { code: true, classId: true, date: true },
    });
  });

  it("drops the semester filter when searchAllSemesters is true", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({ classSession: { findMany } });
    await buildClassNearestSessionMap(prisma, {
      anchorDate: "2026-06-03",
      semesterId: "sem-1",
      searchAllSemesters: true,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        classId: { not: null },
        semester: { deletedAt: null },
        class: { deletedAt: null },
      },
      select: { code: true, classId: true, date: true },
    });
  });

  it("maps each classId to the session nearest to anchorDate", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { code: "2026060201", classId: "class-A", date: "2026-06-02" },
      { code: "2026061001", classId: "class-A", date: "2026-06-10" },
      { code: "2026060501", classId: "class-B", date: "2026-06-05" },
    ]);
    const prisma = fakePrisma({ classSession: { findMany } });
    const result = await buildClassNearestSessionMap(prisma, { anchorDate: "2026-06-03" });
    // class-A: 6/2 距离 1, 6/10 距离 7 → 6/2
    // class-B: 6/5 距离 2
    expect(result.get("class-A")).toBe("2026060201");
    expect(result.get("class-B")).toBe("2026060501");
    expect(result.size).toBe(2);
  });

  it("applies the default 30-day distance cap (DEFAULT_MAX_NEAREST_DISTANCE_DAYS)", async () => {
    expect(DEFAULT_MAX_NEAREST_DISTANCE_DAYS).toBe(30);
    const findMany = vi.fn().mockResolvedValue([
      { code: "2026040101", classId: "class-far", date: "2026-04-01" }, // 距 6/3 = 63 天，过远
      { code: "2026051501", classId: "class-close", date: "2026-05-15" }, // 距 6/3 = 19 天，命中
    ]);
    const prisma = fakePrisma({ classSession: { findMany } });
    const result = await buildClassNearestSessionMap(prisma, { anchorDate: "2026-06-03" });
    expect(result.has("class-far")).toBe(false);
    expect(result.get("class-close")).toBe("2026051501");
  });

  it("respects custom maxDistanceDays override", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { code: "2026051501", classId: "class-A", date: "2026-05-15" }, // 距 6/3 = 19 天
    ]);
    const prisma = fakePrisma({ classSession: { findMany } });
    const strict = await buildClassNearestSessionMap(prisma, { anchorDate: "2026-06-03", maxDistanceDays: 7 });
    expect(strict.size).toBe(0);
    const loose = await buildClassNearestSessionMap(prisma, { anchorDate: "2026-06-03", maxDistanceDays: 30 });
    expect(loose.get("class-A")).toBe("2026051501");
  });
});

describe("pickNearestWithinDistance", () => {
  const sessions = [
    { code: "2026061501", date: "2026-06-15" },
    { code: "2026053001", date: "2026-05-30" },
    { code: "2026060301", date: "2026-06-03" },
  ];

  it("returns null when the nearest session is beyond maxDistanceDays", () => {
    // 6/4 锚点：5/30 距 5, 6/3 距 1, 6/15 距 11 → 最近 6/3 距 1。
    // maxDistanceDays=0：6/3 也超限（6/4 锚点 vs 6/3 是 1 天）→ null
    expect(pickNearestWithinDistance(sessions, "2026-06-04", 0)).toBeNull();
    // maxDistanceDays=1：6/3 距 1 命中
    expect(pickNearestWithinDistance(sessions, "2026-06-04", 1)).toBe("2026060301");
    // maxDistanceDays=2：仍然 6/3 命中
    expect(pickNearestWithinDistance(sessions, "2026-06-04", 2)).toBe("2026060301");
  });

  it("uses distance + date + code ordering like findNearestSessionByDateInList", () => {
    // 6/2 锚点：5/30 距 3, 6/3 距 1 → 6/3
    expect(pickNearestWithinDistance(sessions, "2026-06-02", 30)).toBe("2026060301");
  });

  it("returns null on empty list regardless of limit", () => {
    expect(pickNearestWithinDistance([], "2026-06-03", 30)).toBeNull();
  });
});
