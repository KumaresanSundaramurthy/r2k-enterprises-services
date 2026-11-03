import { phpDate } from "../../common/utils/php-compat";

export interface DateRange {
  range: string;
  from: string;
  to: string;
  label: string;
}

// YYYY-MM-DD of a calendar date (no time-zone shift)
const ymd = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10);
};
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * MY_Controller::_buildDateRange — a saved date-filter preset ("this_month", "last_7_days", "custom|from|to", …)
 * as from / to dates in the organisation's time zone. Unknown presets fall back to this month.
 */
export function buildDateRange(preset: string, timeZone: string, now: Date = new Date()): DateRange {
  if (preset.startsWith("custom|")) {
    const [, from, to] = preset.split("|");
    if (from && to) return { range: preset, from, to, label: "Custom" };
  }

  const today = phpDate("Y-m-d", now, timeZone);
  const [y, m, d] = today.split("-").map(Number);
  const daysAgo = (days: number) => ymd(y, m, d - days);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const fyStart = m >= 4 ? y : y - 1;
  const quarterStart = Math.floor((m - 1) / 3) * 3 + 1;

  const presets: Record<string, Omit<DateRange, "range">> = {
    today: { from: today, to: today, label: "Today" },
    yesterday: { from: daysAgo(1), to: daysAgo(1), label: "Yesterday" },
    this_week: { from: daysAgo(weekday), to: today, label: "This Week" },
    last_week: { from: daysAgo(weekday + 7), to: daysAgo(weekday + 1), label: "Last Week" },
    last_7_days: { from: daysAgo(6), to: today, label: "Last 7 Days" },
    this_month: { from: ymd(y, m, 1), to: today, label: "This Month" },
    previous_month: { from: ymd(y, m - 1, 1), to: ymd(y, m - 1, lastDay(y, m - 1)), label: "Previous Month" },
    last_30_days: { from: daysAgo(29), to: today, label: "Last 30 Days" },
    this_quarter: { from: ymd(y, quarterStart, 1), to: today, label: "This Quarter" },
    previous_quarter: { from: ymd(y, quarterStart - 3, 1), to: ymd(y, quarterStart, 0), label: "Previous Quarter" },
    this_year: { from: ymd(y, 1, 1), to: today, label: "This Year" },
    last_year: { from: ymd(y - 1, 1, 1), to: ymd(y - 1, 12, 31), label: "Last Year" },
    last_365_days: { from: daysAgo(364), to: today, label: "Last 365 Days" },
    current_fy: { from: ymd(fyStart, 4, 1), to: ymd(fyStart + 1, 3, 31), label: "Current FY" },
    previous_fy: { from: ymd(fyStart - 1, 4, 1), to: ymd(fyStart, 3, 31), label: "Previous FY" },
  };
  const range = preset in presets ? preset : "this_month";
  return { range, ...presets[range] };
}
