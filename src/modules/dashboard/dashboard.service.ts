import { Injectable, Logger } from "@nestjs/common";
import { phpDate } from "../../common/utils/php-compat";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { DASHBOARD_MODULES, DashboardDates, DashboardRepository } from "./dashboard.repository";

const { INVOICE, PURCHASE } = DASHBOARD_MODULES;

export const CHART_TYPES = ["sales", "monthly", "receivable", "payable"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/**
 * Dashboard (CI3 Dashboard::index), split into one call per widget so the page can show each widget as soon as
 * its data arrives. Every widget runs the same Dashboard_model queries as CI3 (in parallel); as in CI3, a query
 * that fails is logged and its part of the widget comes back as 0 / empty instead of failing the call.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly repo: DashboardRepository,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // KPI tabs: today's / this month's sales and purchases, to collect, to pay
  async getKpis(orgUID: number, branchUID: number) {
    const dates = await this.dates(orgUID);
    const zeroTotals = { total: 0, count: 0 };
    const zeroMonths = { this_month: 0, last_month: 0 };
    const [todaySales, monthSales, todayPurchases, monthPurchases, receivable, payable] = await Promise.all([
      this.safe("getTodaySales", this.repo.dayTotals(orgUID, branchUID, INVOICE, dates.today), zeroTotals),
      this.safe("getMonthlySalesComparison", this.repo.monthComparison(orgUID, branchUID, INVOICE, dates), zeroMonths),
      this.safe("getTodayPurchases", this.repo.dayTotals(orgUID, branchUID, PURCHASE, dates.today), zeroTotals),
      this.safe("getMonthlyPurchasesComparison", this.repo.monthComparison(orgUID, branchUID, PURCHASE, dates), zeroMonths),
      this.safe("getTotalReceivable", this.repo.totalReceivable(orgUID), 0),
      this.safe("getTotalPayable", this.repo.totalPayable(orgUID), 0),
    ]);
    return {
      TodaySales: todaySales,
      MonthlyComparison: monthSales,
      TodayPurchases: todayPurchases,
      MonthlyPurchasesComparison: monthPurchases,
      TotalReceivable: receivable,
      TotalPayable: payable,
    };
  }

  // Chart of the selected KPI tab: sales (last 30 days), monthly (last 12 months), receivable / payable (last 30 days)
  async getChart(orgUID: number, branchUID: number, type: ChartType) {
    const dates = await this.dates(orgUID);
    const data = {
      sales: () => this.safe("getSalesChartData", this.repo.dailyNetAmounts(orgUID, branchUID, INVOICE, dates.last30Start), []),
      monthly: () => this.safe("getMonthlySalesTrend", this.repo.monthlySalesTrend(orgUID, branchUID, dates.last12MonthsStart), []),
      receivable: () => this.safe("getReceivableTrend", this.repo.receivableTrend(orgUID, branchUID, dates.last30Start), []),
      payable: () => this.safe("getPayableTrend", this.repo.dailyNetAmounts(orgUID, branchUID, PURCHASE, dates.last30Start), []),
    }[type];
    return { Type: type, ChartData: await data() };
  }

  // Pending actions strip
  async getPendingCounts(orgUID: number, branchUID: number) {
    await this.orgSettings.get(orgUID);
    const zero = { draft_count: 0, open_invoices: 0, open_pos: 0, open_purchases: 0 };
    return { PendingCounts: await this.safe("getPendingCounts", this.repo.pendingCounts(orgUID, branchUID), zero) };
  }

  async getOverdueInvoices(orgUID: number, branchUID: number) {
    const dates = await this.dates(orgUID);
    return { OverdueInvoices: await this.safe("getOverdueInvoices", this.repo.overdueInvoices(orgUID, branchUID, dates.today), []) };
  }

  // Top customers + top vendors card
  async getTopParties(orgUID: number) {
    await this.orgSettings.get(orgUID);
    const [customers, vendors] = await Promise.all([this.safe("getTopCustomers", this.repo.topCustomers(orgUID), []), this.safe("getTopVendors", this.repo.topVendors(orgUID), [])]);
    return { TopCustomers: customers, TopVendors: vendors };
  }

  async getRecentTransactions(orgUID: number, branchUID: number) {
    await this.orgSettings.get(orgUID);
    return { RecentTransactions: await this.safe("getRecentTransactions", this.repo.recentTransactions(orgUID, branchUID), []) };
  }

  async getExpenseSummary(orgUID: number) {
    const dates = await this.dates(orgUID);
    return { ExpenseSummary: await this.safe("getExpenseSummary", this.repo.expenseSummary(orgUID, dates.thisMonthStart), []) };
  }

  async getTopProducts(orgUID: number, branchUID: number) {
    const dates = await this.dates(orgUID);
    return { TopProducts: await this.safe("getTopProducts", this.repo.topProducts(orgUID, branchUID, dates.thisMonthStart), []) };
  }

  /** Today, month starts and chart windows in the organisation's timezone (also confirms the org exists). */
  private async dates(orgUID: number): Promise<DashboardDates> {
    const { Timezone } = await this.orgSettings.get(orgUID);
    const today = phpDate("Y-m-d", new Date(), Timezone);
    const [y, m, d] = today.split("-").map(Number);
    return {
      today,
      thisMonthStart: ymd(new Date(Date.UTC(y, m - 1, 1))),
      lastMonthStart: ymd(new Date(Date.UTC(y, m - 2, 1))),
      lastMonthEnd: ymd(new Date(Date.UTC(y, m - 1, 0))),
      last30Start: ymd(new Date(Date.UTC(y, m - 1, d - 29))),
      last12MonthsStart: ymd(new Date(Date.UTC(y, m - 12, 1))),
    };
  }

  // CI3 model try/catch: log the failure (notifyError) and return the widget's empty value
  private async safe<T>(label: string, work: Promise<T>, fallback: T): Promise<T> {
    try {
      return await work;
    } catch (error) {
      this.logger.error(`dashboard_model::${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  }
}
