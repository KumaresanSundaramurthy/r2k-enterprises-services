/**
 * Two-digit financial year for "now" in the organisation's timezone (CI3 _calcFYYear, shared by
 * Customers and Vendors). Months before fyStartMonth belong to the previous year's FY.
 */
export function currentFinancialYear2(fyStartMonth: number, timezone: string): number {
  let year: number;
  let month: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone || "UTC", year: "numeric", month: "numeric" }).formatToParts(
      new Date()
    );
    year = Number(parts.find((p) => p.type === "year")?.value);
    month = Number(parts.find((p) => p.type === "month")?.value);
  } catch {
    // Unknown timezone: fall back to UTC, as CI3 falls back to the server clock
    const now = new Date();
    year = now.getUTCFullYear();
    month = now.getUTCMonth() + 1;
  }
  return (month >= fyStartMonth ? year : year - 1) % 100;
}

/** Four-digit year in which the current financial year started (UTC like CI3's date()), e.g. 2026 for FY 2026-27. */
export function currentFinancialYear(fyStartMonth: number, now: Date = new Date()): number {
  return now.getUTCMonth() + 1 >= fyStartMonth ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

/** First day (YYYY-MM-01, UTC) of the financial year that contains `now`. */
export function financialYearStartDate(fyStartMonth: number, now: Date = new Date()): string {
  return `${currentFinancialYear(fyStartMonth, now)}-${String(fyStartMonth).padStart(2, "0")}-01`;
}

/** First day (YYYY-MM-01, UTC) of the month `offset` months from `now`. */
export function monthStartDate(offset = 0, now: Date = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return date.toISOString().slice(0, 10);
}

/** Last day (YYYY-MM-DD, UTC) of the month `offset` months from `now` — CI3 date('Y-m-t'). */
export function monthEndDate(offset = 0, now: Date = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0));
  return date.toISOString().slice(0, 10);
}

export function padYear2(year2: number): string {
  return String(year2).padStart(2, "0");
}
