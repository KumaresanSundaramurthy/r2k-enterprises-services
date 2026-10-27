import * as bcrypt from "bcryptjs";

// CI3 runs with PHP's default timezone (UTC), so every DATETIME it writes or compares is UTC.
export function nowDateTime(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function todayDate(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function parseDateTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = value.length === 10 ? `${value}T00:00:00Z` : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toInt(value: unknown, fallback = 0): number {
  const parsed = parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// PHP round(): halves round away from zero (Math.round rounds -0.5 towards zero).
export function phpRound(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return (Math.sign(value) * Math.round(Math.abs(value) * factor + Number.EPSILON)) / factor;
}

// PHP's (int)(bool)$value: "0", "", null and the BIT(0) byte are false; anything else is true.
export function phpBool(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const str = String(value);
  return str !== "" && str !== "0" && str !== "\u0000";
}

// CI3 only treats "$2y$" hashes as bcrypt, so hashes written here must use that prefix too.
export async function hashPassword(password: string): Promise<string> {
  const hash = await bcrypt.hash(password, 10);
  return `$2y$${hash.slice(4)}`;
}

export function isBcryptHash(stored: string): boolean {
  return /^\$2[aby]\$/.test(stored);
}

// Legacy CI3 accounts store base64(password); those are upgraded to bcrypt on the next successful login.
export async function verifyPassword(input: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  if (isBcryptHash(stored)) {
    return bcrypt.compare(input, stored);
  }
  return input === Buffer.from(stored, "base64").toString("utf8");
}

export function resolveCdnUrl(path: string | null | undefined): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const cdn = process.env.FILE_UPLOAD === "amazonaws" ? process.env.CDN_URL : process.env.CFLARE_R2_CDN;
  return `${(cdn || "").replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// PHP date($format) for the format characters the CI3 settings use, in the given IANA timezone.
export function phpDate(format: string, date: Date, timeZone = "UTC"): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      weekday: "long",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const hour12 = hour % 12 || 12;
  const pad = (n: number) => String(n).padStart(2, "0");
  const tokens: Record<string, string> = {
    d: pad(day),
    j: String(day),
    D: parts.weekday.slice(0, 3),
    l: parts.weekday,
    N: String(WEEKDAYS.indexOf(parts.weekday) || 7),
    m: pad(month),
    n: String(month),
    M: MONTHS[month - 1].slice(0, 3),
    F: MONTHS[month - 1],
    Y: String(year),
    y: pad(year % 100),
    H: pad(hour),
    G: String(hour),
    h: pad(hour12),
    g: String(hour12),
    i: parts.minute,
    s: parts.second,
    A: hour < 12 ? "AM" : "PM",
    a: hour < 12 ? "am" : "pm",
  };
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch === "\\" && i + 1 < format.length) out += format[++i];
    else out += tokens[ch] ?? ch;
  }
  return out;
}

// CI3 smartDecimal(): up to 9 decimals with trailing zeros (and a trailing point) removed.
export function smartDecimal(value: unknown, maxDecimals = 9): string {
  const formatted = (Number(value) || 0).toFixed(maxDecimals);
  return maxDecimals > 0 ? formatted.replace(/0+$/, "").replace(/\.$/, "") : formatted;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
