import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../../common/redis/redis.service";
import { phpDate, phpRound, smartDecimal } from "../../common/utils/php-compat";
import { CiValidationError } from "../../core/response/ci-response";
import { AssistantContext, AssistantRepository, SnapshotDates } from "./assistant.repository";
import { ChatTurn, GeminiClient } from "./gemini.client";

const MAX_MESSAGE_CHARS = 600;
const MAX_HISTORY_TURNS = 6; // ai_config gemini_max_history_turns
const SESSION_LIMIT = 30; // ai_config gemini_session_limit
const FALLBACK_TTL_SECS = 86_400;

export interface ChatCaller { orgUID: number; branchUID: number; userUID: number; sessionKey?: string }

// CI3 Assistant controller — AI Business Assistant
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly repo: AssistantRepository,
    private readonly gemini: GeminiClient,
    private readonly redis: RedisService
  ) {}

  // chat — answers one question from a live business snapshot; at most 30 answered questions per login session
  async chat(caller: ChatCaller, rawMessage: unknown, rawHistory: unknown) {
    const info = await this.repo.promptInfo(caller.orgUID, caller.userUID);
    if (!info) throw new CiValidationError("Organisation not found.");
    if (!info.aiEnabled) throw new CiValidationError("AI Business Assistant is not enabled for this organisation.");

    const counter = await this.counterOf(caller);
    const used = await this.callsUsed(counter.key);
    if (used >= SESSION_LIMIT) throw new CiValidationError("AI request limit reached for this session. Please log out and back in to reset.");

    const message = String(rawMessage ?? "").trim();
    if (message === "") throw new CiValidationError("Message cannot be empty.");
    if (Array.from(message).length > MAX_MESSAGE_CHARS) throw new CiValidationError(`Message is too long (maximum ${MAX_MESSAGE_CHARS} characters).`);

    const dates = AssistantService.datesIn(info.timezone);
    const context = await this.repo.buildContext(caller.orgUID, caller.branchUID, dates);
    const prompt = AssistantService.systemPrompt({ ...info, today: phpDate("d M Y", new Date(), info.timezone) }, context);

    const reply = await this.gemini.chat(prompt, AssistantService.historyOf(rawHistory), message);

    // Counted only when Gemini answered
    await this.countCall(counter, used + 1);
    return { Message: "OK", Reply: reply };
  }

  // Business snapshot, worded exactly as CI3's prompt
  private static systemPrompt(info: { orgName: string; userName: string; currency: string; today: string }, ctx: AssistantContext): string {
    const fmt = (value: unknown) => smartDecimal(value);
    const { currency } = info;
    const sales = ctx.sales;
    const change = sales.lastMonth > 0 ? phpRound(((sales.thisMonth - sales.lastMonth) / sales.lastMonth) * 100, 1) : 0;
    const changeTxt = change >= 0 ? `+${change}% vs last month` : `${change}% vs last month`;
    const customers = ctx.topCustomers.map((r) => `${(r.Name ?? "").trim()} (${currency}${fmt(r.total)})`);
    const products = ctx.topProducts.map((r) => `${(r.ItemName ?? "").trim()} (${fmt(r.qty_sold)} units)`);
    const t = ctx.today;

    return (
      `You are a smart business assistant for ${info.orgName || "Your Business"}, an agricultural machinery ERP.\n` +
      `The user is ${info.userName || "there"}. Today is ${info.today}.\n` +
      "Answer questions about the business data below clearly and concisely — 2 to 4 sentences maximum.\n" +
      `Format monetary amounts with commas. Always use this currency symbol: ${currency}\n` +
      "If asked something not found in the data, say so honestly — do not fabricate data.\n\n" +
      "=== LIVE BUSINESS SNAPSHOT ===\n" +
      `This Month Sales: ${currency}${fmt(sales.thisMonth)} (${sales.thisCount} invoices, ${changeTxt})\n` +
      `Last Month Sales: ${currency}${fmt(sales.lastMonth)}\n` +
      `Total Customer Receivable (outstanding): ${currency}${fmt(ctx.receivable)}\n` +
      `Total Vendor Payable (outstanding): ${currency}${fmt(ctx.payable)}\n` +
      `Overdue Invoices: ${ctx.overdue}\n` +
      `Low Stock Products: ${ctx.lowStock}\n` +
      `Today's Transactions: ${t.total} total ` +
      `(${t.invoices} invoices, ${t.purchases} purchases, ${t.payments} payments)\n` +
      (customers.length ? `Top 5 Customers This Month: ${customers.join("; ")}\n` : "") +
      (products.length ? `Top 5 Products This Month: ${products.join("; ")}\n` : "")
    );
  }

  // history — JSON string (as the widget posts it) or array; last 6 turns, role user/model, tags stripped
  private static historyOf(raw: unknown): ChatTurn[] {
    let list: unknown = raw;
    if (typeof raw === "string") {
      try {
        list = JSON.parse(raw);
      } catch {
        list = [];
      }
    }
    if (!Array.isArray(list)) return [];
    return list
      .slice(-MAX_HISTORY_TURNS)
      .filter((turn): turn is { role: unknown; text: unknown } => !!turn && typeof turn === "object" && "role" in turn && "text" in turn && turn.role != null && turn.text != null)
      .map((turn) => ({ role: turn.role === "model" ? "model" : "user", text: String(turn.text).replace(/<[^>]*>/g, "") }));
  }

  // Today, the first day of this month, and last month's first and last day — in the organisation's timezone
  private static datesIn(timeZone: string): SnapshotDates {
    const today = phpDate("Y-m-d", new Date(), timeZone);
    const [year, month] = today.split("-").map(Number);
    const pad = (n: number) => String(n).padStart(2, "0");
    const lastYear = month === 1 ? year - 1 : year;
    const lastMonth = month === 1 ? 12 : month - 1;
    const lastDay = new Date(Date.UTC(lastYear, lastMonth, 0)).getUTCDate();
    return {
      today,
      thisStart: `${year}-${pad(month)}-01`,
      lastStart: `${lastYear}-${pad(lastMonth)}-01`,
      lastEnd: `${lastYear}-${pad(lastMonth)}-${pad(lastDay)}`,
    };
  }

  // The count lives as long as the login session (CI3 kept it in the PHP session); without a session key, per user
  private async counterOf(caller: ChatCaller): Promise<{ key: string; ttl: number }> {
    const fallbackTtl = Number(process.env.LOGIN_EXPIRE_SECS) || FALLBACK_TTL_SECS;
    if (caller.sessionKey) {
      const sessionTtl = await this.redis.ttl(caller.sessionKey).catch(() => -1);
      return { key: `${caller.sessionKey}_AiCalls`, ttl: sessionTtl > 0 ? sessionTtl : fallbackTtl };
    }
    return { key: this.redis.envKey(`AiCalls_${caller.orgUID}_${caller.userUID}`), ttl: fallbackTtl };
  }

  private async callsUsed(key: string): Promise<number> {
    try {
      return Number(await this.redis.get<number>(key)) || 0;
    } catch (err) {
      this.logger.warn(`AI call count unavailable: ${(err as Error).message}`);
      return 0;
    }
  }

  private async countCall(counter: { key: string; ttl: number }, calls: number): Promise<void> {
    try {
      await this.redis.set(counter.key, calls, counter.ttl);
    } catch (err) {
      this.logger.warn(`AI call count not saved: ${(err as Error).message}`);
    }
  }
}
