const DATE_TOKEN_SOURCE = String.raw`(?<!\d)(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?!\d)`;
const DATE_TOKEN_PATTERN = new RegExp(DATE_TOKEN_SOURCE, "g");
const DATE_RANGE_PATTERN = new RegExp(
  `${DATE_TOKEN_SOURCE}\\s*(?:至|到|～|~)\\s*${DATE_TOKEN_SOURCE}`,
  "g",
);

export interface FeedbackDateRange {
  start: string;
  end: string;
}

function validDate(year: number, month: number, day: number) {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function dateToken(year: string, month: string, day: string) {
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  if (!validDate(numericYear, numericMonth, numericDay)) return null;
  return `${numericYear.toString().padStart(4, "0")}-${numericMonth.toString().padStart(2, "0")}-${numericDay.toString().padStart(2, "0")}`;
}

export function extractFeedbackDateRange(value: unknown): FeedbackDateRange | null {
  if (typeof value !== "string") return null;
  const matches = [...value.matchAll(DATE_TOKEN_PATTERN)]
    .map((match) => dateToken(match[1], match[2], match[3]))
    .filter((date): date is string => Boolean(date));
  if (matches.length === 0) return null;
  const dates = [...new Set(matches)].sort();
  return { start: dates[0], end: dates[dates.length - 1] };
}

export function feedbackDateRangeLabel(range: FeedbackDateRange | null | undefined) {
  if (!range) return "时间未知";
  return range.start === range.end ? range.start : `${range.start}至${range.end}`;
}

function dayDifference(referenceDate: string, date: string) {
  const reference = extractFeedbackDateRange(referenceDate)?.end;
  if (!reference) return null;
  const referenceTime = Date.parse(`${reference}T00:00:00Z`);
  const dateTime = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(referenceTime) || !Number.isFinite(dateTime)) return null;
  return Math.round((dateTime - referenceTime) / 86_400_000);
}

function relativeSingleDate(referenceDate: string, date: string) {
  const difference = dayDifference(referenceDate, date);
  if (difference === null) return "时间未知";
  if (difference === 0) return "今天";
  if (difference === -1) return "昨天";
  if (difference === -2) return "前天";
  if (difference < 0) return "更早";
  return "之后";
}

export function relativeFeedbackDateLabel(referenceDate: string, occurredAt: unknown) {
  const range = extractFeedbackDateRange(occurredAt);
  if (!range) return "时间未知";
  if (range.start === range.end) return relativeSingleDate(referenceDate, range.start);
  const start = relativeSingleDate(referenceDate, range.start);
  const end = relativeSingleDate(referenceDate, range.end);
  if (start === end) return `${start}的一段时间`;
  return `${start}至${end}`;
}

export function replaceFeedbackDatesWithRelativeLabels(value: string, referenceDate?: string) {
  if (!referenceDate || !extractFeedbackDateRange(referenceDate)) return value;
  const withRanges = value.replace(
    DATE_RANGE_PATTERN,
    (match, startYear: string, startMonth: string, startDay: string, endYear: string, endMonth: string, endDay: string) => {
      const start = dateToken(startYear, startMonth, startDay);
      const end = dateToken(endYear, endMonth, endDay);
      return start && end ? relativeFeedbackDateLabel(referenceDate, `${start}至${end}`) : match;
    },
  );
  return withRanges.replace(DATE_TOKEN_PATTERN, (match, year: string, month: string, day: string) => {
    const date = dateToken(year, month, day);
    return date ? relativeSingleDate(referenceDate, date) : match;
  });
}
