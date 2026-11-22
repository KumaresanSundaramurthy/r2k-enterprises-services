const IST_OFFSET_MS = 19800 * 1000; // UTC+5:30 in milliseconds

/**
 * April–March billing financial year label (UTC clock, matches CI3's billing_fy()).
 * "long"  → "2026-27"   (default; invoice numbers, DB FinancialYear columns)
 * "code"  → "2627"      (compact; prefix strings)
 * "full"  → "2026-2027" (billing module reports)
 *
 * @param format  Output format — "long" | "code" | "full"
 * @returns Financial year string
 */
export function billingFy(format: "long" | "code" | "full" = "long"): string {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const start = month >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const end = start + 1;
  if (format === "code") return `${String(start).slice(2)}${String(end).slice(2)}`;
  if (format === "full") return `${start}-${end}`;
  return `${start}-${String(end).slice(2)}`;
}

/**
 * Subscription plan end date: 23:59:59 IST of the day that is `durationDays` from now
 * (or from `prevEndDateStr` when that date is still in the future), stored as UTC.
 * Mirrors CI3's _calcEndDate() / gmmktime(...) - 19800.
 *
 * @param durationDays    Days to add (minimum 1)
 * @param prevEndDateStr  Optional existing end date to extend from (ISO or MySQL datetime)
 * @returns UTC datetime string "YYYY-MM-DD HH:MM:SS"
 */
export function calcPlanEndDate(durationDays: number, prevEndDateStr?: string | null): string {
  const nowTs = Math.floor(Date.now() / 1000);
  let baseTs = nowTs;
  if (prevEndDateStr) {
    const prevTs = Math.floor(new Date(String(prevEndDateStr).replace(" ", "T")).getTime() / 1000);
    if (prevTs > nowTs) baseTs = prevTs;
  }
  const futureTs = baseTs + Math.max(1, durationDays) * 86400;
  const istDate = new Date(futureTs * 1000 + IST_OFFSET_MS);
  const y = istDate.getUTCFullYear();
  const m = istDate.getUTCMonth();
  const d = istDate.getUTCDate();
  const eodUtcMs = Date.UTC(y, m, d, 23, 59, 59) - IST_OFFSET_MS;
  return new Date(eodUtcMs).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Add `days` calendar days to a YYYY-MM-DD date string.
 *
 * @param dateStr  Source date as YYYY-MM-DD
 * @param days     Number of days to add
 * @returns YYYY-MM-DD string
 */
export function addDays(dateStr: string, days: number): string {
  return new Date(new Date(dateStr).getTime() + days * 86400000).toISOString().slice(0, 10);
}
