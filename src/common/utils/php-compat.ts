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

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
