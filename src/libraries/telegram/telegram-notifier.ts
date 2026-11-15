import { Logger } from "@nestjs/common";
import { waitUntil } from "@vercel/functions";
import { phpDate } from "../../common/utils/php-compat";

type Context = Record<string, unknown>;

const API_BASE = "https://api.telegram.org/bot";
const SEND_TIMEOUT_MS = 5000;
// The same error (title + message) is sent at most once per window per instance, so a failing loop can't flood the chat
const COOLDOWN_MS = 60_000;

const logger = new Logger("TelegramNotifier");
const lastSent = new Map<string, number>();

const esc = (text: unknown) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const now = () => `${phpDate("d M Y  H:i:s", new Date(), "UTC")} UTC`;

// "at fn (C:\…\dist\modules\x\y.js:12:34)" → "modules/x/y.js:12" — the first frame of our own code
function sourceOf(err: Error): string {
  for (const line of (err.stack ?? "").split("\n").slice(1)) {
    const match = /\(?([^()\s]+):(\d+):\d+\)?\s*$/.exec(line.trim());
    if (!match || match[1].includes("node_modules") || match[1].startsWith("node:")) continue;
    const file = match[1].replace(/\\/g, "/");
    const idx = file.search(/\/(dist|src)\//);
    return `${idx >= 0 ? file.slice(idx + 1) : file}:${match[2]}`;
  }
  return "";
}

function contextLines(context: Context): string[] {
  const entries = Object.entries(context).filter(([, value]) => value !== undefined);
  return entries.length === 0 ? [] : ["", ...entries.map(([key, value]) => `\u2022 <b>${esc(key)}:</b> ${esc(value)}`)];
}

/**
 * CI3 Telegramnotifier: error and alert messages to a Telegram chat through the Bot API (TELEGRAM_BOT_TOKEN,
 * TELEGRAM_CHAT_ID). Static, so filters and services use it without injection. Sending never blocks or fails the
 * request: on Vercel it is handed to waitUntil, failures are only logged, and without the env vars nothing is sent.
 */
export class TelegramNotifier {
  /** Telegramnotifier::error — an exception with where it happened; url is the request (CI3 printed the current URL). */
  static error(title: string, err?: unknown, context: Context = {}, url?: string): void {
    const error = err instanceof Error ? err : err !== undefined ? new Error(String(err)) : null;
    if (TelegramNotifier.inCooldown(`E|${title}|${error?.message ?? ""}`)) return;

    const lines = ["\u{1F6A8} <b>ERROR</b>", `<b>${esc(title)}</b>`, ""];
    if (error) {
      lines.push(`\u{1F4CB} <b>Message:</b> ${esc(error.message)}`);
      const source = sourceOf(error);
      if (source) lines.push(`\u{1F4CD} <b>File:</b> <code>${esc(source)}</code>`);
    }
    lines.push(...contextLines(context));
    lines.push("", `\u{1F310} <b>URL:</b> <code>${esc(url ?? "—")}</code>`, `\u{1F550} <b>Time:</b> ${now()}`, `\u2699\uFE0F <b>Env:</b> ${esc(process.env.CI_ENV || "unknown")}`);
    TelegramNotifier.send(lines.join("\n"));
  }

  /**
   * TELEGRAM_NOTIFY_LEVEL: "all" (default, like CI3 — validation / user errors are sent too) or "errors" (only
   * unexpected and server errors).
   */
  static notifyValidation(): boolean {
    return (process.env.TELEGRAM_NOTIFY_LEVEL || "all").trim().toLowerCase() !== "errors";
  }

  /** A validation / user error (Error: true message, 4xx) — sent only when TELEGRAM_NOTIFY_LEVEL is "all". */
  static validation(title: string, message: string, context: Context = {}, url?: string): void {
    if (!TelegramNotifier.notifyValidation()) return;
    if (TelegramNotifier.inCooldown(`V|${title}|${message}`)) return;
    const lines = ["⚠️ <b>VALIDATION</b>", `<b>${esc(title)}</b>`, "", `\u{1F4CB} <b>Message:</b> ${esc(message)}`];
    lines.push(...contextLines(context));
    lines.push("", `\u{1F310} <b>URL:</b> <code>${esc(url ?? "—")}</code>`, `\u{1F550} <b>Time:</b> ${now()}`, `⚙️ <b>Env:</b> ${esc(process.env.CI_ENV || "unknown")}`);
    TelegramNotifier.send(lines.join("\n"));
  }

  /** Telegramnotifier::alert — an informational message (no exception). */
  static alert(title: string, context: Context = {}): void {
    if (TelegramNotifier.inCooldown(`A|${title}|${JSON.stringify(context)}`)) return;
    const lines = ["\u26A0\uFE0F <b>ALERT</b>", `<b>${esc(title)}</b>`, ...contextLines(context), "", `\u{1F550} <b>Time:</b> ${now()}`];
    TelegramNotifier.send(lines.join("\n"));
  }

  private static inCooldown(key: string): boolean {
    const at = Date.now();
    const previous = lastSent.get(key);
    if (previous !== undefined && at - previous < COOLDOWN_MS) return true;
    lastSent.set(key, at);
    if (lastSent.size > 500) {
      for (const [k, t] of lastSent) if (at - t >= COOLDOWN_MS) lastSent.delete(k);
    }
    return false;
  }

  private static send(text: string): void {
    // TELEGRAM_ENABLED=no (or false / 0 / off) switches every notification off; anything else, or unset, keeps them on
    if (["no", "false", "0", "off"].includes((process.env.TELEGRAM_ENABLED ?? "").trim().toLowerCase())) return;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const task = fetch(`${API_BASE}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
      .then(async (res) => {
        if (!res.ok) logger.warn(`Telegram send failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      })
      .catch((err) => logger.warn(`Telegram send failed: ${(err as Error).message}`));

    try {
      waitUntil(task);
    } catch {
      // Not on Vercel: the promise finishes on the long-lived server
    }
  }
}
