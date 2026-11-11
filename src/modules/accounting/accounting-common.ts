import { phpDate } from "../../common/utils/php-compat";

export type Side = "Debit" | "Credit";

export const LEDGER_TYPES = ["Asset", "Liability", "Income", "Expense", "Customer", "Vendor", "Employee", "Bank", "Cash"] as const;
export const FREQUENCIES = ["Daily", "Weekly", "Monthly", "Quarterly", "Yearly"] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A real Y-m-d date
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// PHP date('Y-m-d', strtotime($value)) for the date formats the pages send; null when not a date
export function toIsoDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (isIsoDate(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : phpDate("Y-m-d", parsed, "UTC");
}

// Accounting::_calcBalance — a balance after debits / credits; it flips side when it goes below zero
export function calcBalance(balance: number, side: Side, debit: number, credit: number): [number, Side] {
  const net = balance + (side === "Debit" ? debit - credit : credit - debit);
  if (net >= 0) return [net, side];
  return [Math.abs(net), side === "Debit" ? "Credit" : "Debit"];
}

export const sideOf = (value: unknown): Side => (value === "Credit" ? "Credit" : "Debit");
export const num = (value: unknown): number => Number(value ?? 0) || 0;

// PHP round(x, 1) as a percentage, or null when the base is (near) zero
export function pct(part: number, base: number, digits = 1): number | null {
  if (Math.abs(base) <= 0.005) return null;
  const f = 10 ** digits;
  const v = (part / base) * 100;
  return (Math.sign(v) * Math.round(Math.abs(v) * f + Number.EPSILON)) / f;
}

export function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return (Math.sign(value) * Math.round(Math.abs(value) * f + Number.EPSILON)) / f;
}

// Y-m-d shifted by days (PHP strtotime('-30 days'))
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Accounting::_advanceNextRunDate — PHP strtotime('+1 month') etc. (month ends overflow the way PHP does)
export function advanceRunDate(date: string, frequency: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  switch (frequency) {
    case "Daily":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "Weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "Quarterly":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "Yearly":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    default:
      d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d.toISOString().slice(0, 10);
}
