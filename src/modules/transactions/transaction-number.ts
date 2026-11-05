// Document numbers from a prefix (CI3 MY_Controller::buildUniqueNumber / _buildNumberFromComponentConfig).

export interface PrefixRow {
  PrefixUID?: unknown;
  Name?: unknown;
  IncludeFiscalYear?: unknown;
  FiscalYearFormat?: unknown;
  IncludeShortName?: unknown;
  ShortName?: unknown;
  Separator?: unknown;
  NumberPadding?: unknown;
  ComponentConfig?: unknown;
}

interface ComponentConfig {
  order?: string[];
  seps?: string[];
  active?: Record<string, boolean>;
  shortname?: string;
  fiscalFmt?: string;
}

// Highest TransNumber MySQL's INT column holds
export const MAX_TRANS_NUMBER = 2147483647;

const isSet = (value: unknown) => !!value && value !== "0" && value !== "\u0000";
const pad2 = (n: number) => String(n % 100).padStart(2, "0");

// Indian financial year (April–March) of a Y-m-d date: "26-27" (SHORT) or "2026-2027" (LONG)
function fiscalYear(date: string, format: string): string {
  const [year, month] = date.slice(0, 10).split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return format === "LONG" ? `${start}-${start + 1}` : `${pad2(start)}-${pad2(start + 1)}`;
}

const padded = (number: number, padding: number) => (padding > 1 ? String(number).padStart(padding, "0") : String(number));

/**
 * The UniqueNumber for a transaction number on a date, e.g. EST/26-27/001. A prefix with a ComponentConfig
 * (the prefix builder) uses its own part order and separators; older prefixes use the individual columns.
 */
export function buildUniqueNumber(prefix: PrefixRow, transNumber: number, transDate: string): string {
  const config = parseConfig(prefix.ComponentConfig);
  if (config?.order?.length) return fromComponentConfig(config, prefix, transDate, transNumber);

  const parts = [String(prefix.Name ?? "").toUpperCase()];
  if (isSet(prefix.IncludeShortName) && prefix.ShortName) parts.push(String(prefix.ShortName).toUpperCase());
  if (isSet(prefix.IncludeFiscalYear)) parts.push(fiscalYear(transDate, String(prefix.FiscalYearFormat ?? "SHORT")));
  parts.push(padded(transNumber, Number(prefix.NumberPadding ?? 1)));
  return parts.join(String(prefix.Separator ?? "-"));
}

function parseConfig(value: unknown): ComponentConfig | null {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ComponentConfig) : null;
  } catch {
    return null;
  }
}

// _buildNumberFromComponentConfig — the active parts in the configured order, each followed by its own separator
function fromComponentConfig(config: ComponentConfig, prefix: PrefixRow, date: string, transNumber: number): string {
  const order = config.order ?? ["prefix", "shortname", "fiscal", "number"];
  const seps = config.seps ?? [];
  const active = config.active ?? {};
  const alwaysOn: Record<string, boolean> = { prefix: true, number: true };
  const values: Record<string, string> = {
    prefix: String(prefix.Name ?? "").toUpperCase(),
    shortname: String(config.shortname ?? "").toUpperCase(),
    fiscal: fiscalYear(date, config.fiscalFmt ?? String(prefix.FiscalYearFormat ?? "SHORT")),
    number: padded(transNumber, Number(prefix.NumberPadding ?? 1)),
  };
  const parts = order
    .map((key, index) => ({ key, index }))
    .filter(({ key }) => alwaysOn[key] || active[key])
    .map(({ key, index }) => ({ value: values[key] ?? "", index }))
    .filter(({ value }) => value !== "");
  return parts.map((part, i) => part.value + (i < parts.length - 1 ? (seps[part.index] ?? "-") : "")).join("");
}
