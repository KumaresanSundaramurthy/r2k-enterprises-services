import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

const TRANS = "Transaction.TransactionsTbl";
const INVOICE = 103;
const PURCHASE_ORDER = 104;
const PURCHASE = 105;
// Documents that are not (yet / any more) real sales or purchases
const NOT_COUNTED = ["Draft", "Cancelled", "Rejected"];

/** Org-local dates the dashboard queries use (CI3 used the PHP server's date()). */
export interface DashboardDates {
  today: string; // Y-m-d
  thisMonthStart: string; // Y-m-01
  lastMonthStart: string;
  lastMonthEnd: string;
  last30Start: string; // today - 29 days
  last12MonthsStart: string; // first day of the month 11 months ago
}

export interface Totals {
  total: number;
  count: number;
}

export interface MonthComparison {
  this_month: number;
  last_month: number;
}

/**
 * CI3 Dashboard_model: one method per model function, each a single read query. Branch 0 means every branch
 * (CI3 adds the BranchUID condition only when it is above 0).
 */
@Injectable()
export class DashboardRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getTotalReceivable — customers who owe us (Debit balances); whole org
  async totalReceivable(orgUID: number): Promise<number> {
    const row = await this.read("Customers.CustOpeningBalanceTbl")
      .sum("PendingBalance as total")
      .where({ OrgUID: orgUID, PendingBalType: "Debit", IsDeleted: 0 })
      .first();
    return Number(row?.total ?? 0);
  }

  // getTotalPayable — what we owe vendors (Credit balances); whole org
  async totalPayable(orgUID: number): Promise<number> {
    const row = await this.read("Vendors.VendOpeningBalanceTbl")
      .sum("PendingBalance as total")
      .where({ OrgUID: orgUID, PendingBalType: "Credit", IsDeleted: 0 })
      .first();
    return Number(row?.total ?? 0);
  }

  // getTodaySales (103) / getTodayPurchases (105) — total and count of today's documents
  async dayTotals(orgUID: number, branchUID: number, moduleUID: number, day: string): Promise<Totals> {
    const row = await this.counted(orgUID, branchUID, moduleUID).sum("NetAmount as total").count("* as count").whereRaw("DATE(??) = ?", ["TransDate", day]).first();
    return { total: Number(row?.total ?? 0), count: Number(row?.count ?? 0) };
  }

  // getMonthlySalesComparison (103) / getMonthlyPurchasesComparison (105) — this month vs last month
  async monthComparison(orgUID: number, branchUID: number, moduleUID: number, dates: DashboardDates): Promise<MonthComparison> {
    const row = await this.counted(orgUID, branchUID, moduleUID)
      .select(
        this.read.raw("COALESCE(SUM(CASE WHEN ?? >= ? THEN ?? ELSE 0 END), 0) AS this_month", ["TransDate", dates.thisMonthStart, "NetAmount"]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? BETWEEN ? AND ? THEN ?? ELSE 0 END), 0) AS last_month", ["TransDate", dates.lastMonthStart, dates.lastMonthEnd, "NetAmount"])
      )
      .where("TransDate", ">=", dates.lastMonthStart)
      .first();
    return { this_month: Number(row?.this_month ?? 0), last_month: Number(row?.last_month ?? 0) };
  }

  // getSalesChartData (103) / getPayableTrend (105) — NetAmount per day since `from`
  dailyNetAmounts(orgUID: number, branchUID: number, moduleUID: number, from: string): Promise<Row[]> {
    return this.counted(orgUID, branchUID, moduleUID)
      .select(this.read.raw("DATE(??) AS sale_date", ["TransDate"]), this.read.raw("COALESCE(SUM(??), 0) AS total", ["NetAmount"]))
      .where("TransDate", ">=", from)
      .groupByRaw("DATE(??)", ["TransDate"])
      .orderBy("sale_date", "asc");
  }

  // getReceivableTrend — open invoice balances (Issued / Partial) per day since `from`
  receivableTrend(orgUID: number, branchUID: number, from: string): Promise<Row[]> {
    return this.scoped(orgUID, branchUID, INVOICE)
      .select(this.read.raw("DATE(??) AS sale_date", ["TransDate"]), this.read.raw("COALESCE(SUM(??), 0) AS total", ["BalanceAmount"]))
      .where("TransDate", ">=", from)
      .whereIn("DocStatus", ["Issued", "Partial"])
      .groupByRaw("DATE(??)", ["TransDate"])
      .orderBy("sale_date", "asc");
  }

  // getMonthlySalesTrend — invoice NetAmount per month since `from`
  monthlySalesTrend(orgUID: number, branchUID: number, from: string): Promise<Row[]> {
    return this.counted(orgUID, branchUID, INVOICE)
      .select(this.read.raw("DATE_FORMAT(??, '%Y-%m-01') AS sale_date", ["TransDate"]), this.read.raw("COALESCE(SUM(??), 0) AS total", ["NetAmount"]))
      .where("TransDate", ">=", from)
      .groupByRaw("DATE_FORMAT(??, '%Y-%m-01')", ["TransDate"])
      .orderBy("sale_date", "asc");
  }

  // getOverdueInvoices — open invoices past their due date with a balance, oldest due first, 6 at most
  overdueInvoices(orgUID: number, branchUID: number, today: string): Promise<Row[]> {
    const query = this.read(`${TRANS} as T`)
      .select(
        "T.TransUID",
        "T.UniqueNumber",
        "T.NetAmount",
        "T.BalanceAmount",
        "T.TransDate",
        "D.ValidityDate",
        this.read.raw("COALESCE(??, '') AS ??", ["C.Name", "PartyName"])
      )
      .leftJoin("Transaction.TransDetailTbl as D", (on) => on.on("D.TransUID", "T.TransUID").andOn(this.read.raw("?? = YEAR(??)", ["D.FinancialYear", "T.TransDate"])))
      .leftJoin("Customers.CustomerTbl as C", "C.CustomerUID", "T.PartyUID")
      .where({ "T.OrgUID": orgUID, "T.ModuleUID": INVOICE, "T.IsDeleted": 0 })
      .whereIn("T.DocStatus", ["Issued", "Partial"])
      .where("D.ValidityDate", "<", today)
      .whereNotNull("D.ValidityDate")
      .where("T.BalanceAmount", ">", 0)
      .orderBy("D.ValidityDate", "asc")
      .limit(6);
    if (branchUID > 0) query.where("T.BranchUID", branchUID);
    return query;
  }

  // getTopCustomers — 5 largest receivable balances; whole org
  topCustomers(orgUID: number): Promise<Row[]> {
    return this.read("Customers.CustOpeningBalanceTbl as COB")
      .select("C.Name", "C.MobileNumber", "COB.PendingBalance")
      .leftJoin("Customers.CustomerTbl as C", "C.CustomerUID", "COB.CustomerUID")
      .where({ "COB.OrgUID": orgUID, "COB.PendingBalType": "Debit", "COB.IsDeleted": 0 })
      .where("COB.PendingBalance", ">", 0)
      .orderBy("COB.PendingBalance", "desc")
      .limit(5);
  }

  // getTopVendors — 5 largest payable balances; whole org
  topVendors(orgUID: number): Promise<Row[]> {
    return this.read("Vendors.VendOpeningBalanceTbl as VOB")
      .select("V.Name", "V.MobileNumber", "VOB.PendingBalance")
      .leftJoin("Vendors.VendorTbl as V", "V.VendorUID", "VOB.VendorUID")
      .where({ "VOB.OrgUID": orgUID, "VOB.PendingBalType": "Credit", "VOB.IsDeleted": 0 })
      .where("VOB.PendingBalance", ">", 0)
      .orderBy("VOB.PendingBalance", "desc")
      .limit(5);
  }

  // getRecentTransactions — latest 10 documents of any module
  recentTransactions(orgUID: number, branchUID: number): Promise<Row[]> {
    const query = this.read(`${TRANS} as T`)
      .select("T.UniqueNumber", "T.TransType", "T.NetAmount", "T.DocStatus", "T.TransDate", "T.ModuleUID", this.read.raw("COALESCE(??, ??, '') AS ??", ["C.Name", "V.Name", "PartyName"]))
      .leftJoin("Customers.CustomerTbl as C", (on) => on.on("C.CustomerUID", "T.PartyUID").andOnVal("T.PartyType", "C"))
      .leftJoin("Vendors.VendorTbl as V", (on) => on.on("V.VendorUID", "T.PartyUID").andOnVal("T.PartyType", "S"))
      .where({ "T.OrgUID": orgUID, "T.IsDeleted": 0 })
      .whereNotIn("T.DocStatus", NOT_COUNTED)
      .orderBy("T.TransUID", "desc")
      .limit(10);
    if (branchUID > 0) query.where("T.BranchUID", branchUID);
    return query;
  }

  // getPendingCounts — drafts, open invoices, open purchase orders, open purchases
  async pendingCounts(orgUID: number, branchUID: number): Promise<Record<string, number>> {
    const query = this.read(TRANS)
      .select(
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = 'Draft' THEN 1 ELSE 0 END), 0) AS draft_count", ["DocStatus"]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = ? AND ?? IN ('Issued','Partial') THEN 1 ELSE 0 END), 0) AS open_invoices", ["ModuleUID", INVOICE, "DocStatus"]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = ? AND ?? NOT IN ('Draft','Cancelled','Rejected','Closed','Received') THEN 1 ELSE 0 END), 0) AS open_pos", [
          "ModuleUID",
          PURCHASE_ORDER,
          "DocStatus",
        ]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = ? AND ?? NOT IN ('Draft','Cancelled','Rejected','Closed') THEN 1 ELSE 0 END), 0) AS open_purchases", [
          "ModuleUID",
          PURCHASE,
          "DocStatus",
        ])
      )
      .where({ OrgUID: orgUID, IsDeleted: 0 });
    if (branchUID > 0) query.where("BranchUID", branchUID);
    const row: Row | undefined = await query.first();
    return {
      draft_count: Number(row?.draft_count ?? 0),
      open_invoices: Number(row?.open_invoices ?? 0),
      open_pos: Number(row?.open_pos ?? 0),
      open_purchases: Number(row?.open_purchases ?? 0),
    };
  }

  // getExpenseSummary — this month's expenses, top 5 categories by amount; whole org
  expenseSummary(orgUID: number, monthStart: string): Promise<Row[]> {
    return this.read("Transaction.ExpensesTbl as e")
      .select(this.read.raw("COALESCE(??, 'Uncategorized') AS category", ["ec.CategoryName"]), this.read.raw("COALESCE(SUM(??), 0) AS total", ["e.NetAmount"]))
      .leftJoin("Transaction.ExpenseCategoryTbl as ec", (on) => on.on("ec.CategoryUID", "e.CategoryUID").andOnVal("ec.IsDeleted", "=", 0))
      .where({ "e.OrgUID": orgUID, "e.IsDeleted": 0 })
      .where("e.ExpenseDate", ">=", monthStart)
      .whereNotIn("e.DocStatus", ["Draft", "Cancelled"])
      .groupBy("e.CategoryUID")
      .orderBy("total", "desc")
      .limit(5);
  }

  // getTopProducts — this month's 5 best-selling products by invoiced revenue
  topProducts(orgUID: number, branchUID: number, monthStart: string): Promise<Row[]> {
    const query = this.read("Transaction.TransProductsTbl as TI")
      .select("P.ItemName as ProductName", this.read.raw("SUM(??) AS qty_sold", ["TI.Quantity"]), this.read.raw("COALESCE(SUM(??), 0) AS revenue", ["TI.NetAmount"]))
      .join(`${TRANS} as T`, "T.TransUID", "TI.TransUID")
      .leftJoin("Products.ProductTbl as P", "P.ProductUID", "TI.ProductUID")
      .where({ "T.OrgUID": orgUID, "T.ModuleUID": INVOICE, "T.IsDeleted": 0, "TI.IsDeleted": 0 })
      .where("T.TransDate", ">=", monthStart)
      .whereNotIn("T.DocStatus", NOT_COUNTED)
      .groupBy("TI.ProductUID")
      .orderBy("revenue", "desc")
      .limit(5);
    if (branchUID > 0) query.where("T.BranchUID", branchUID);
    return query;
  }

  // The org's (and branch's) live documents of one module
  private scoped(orgUID: number, branchUID: number, moduleUID: number): Knex.QueryBuilder {
    const query = this.read(TRANS).where({ OrgUID: orgUID, ModuleUID: moduleUID, IsDeleted: 0 });
    if (branchUID > 0) query.where("BranchUID", branchUID);
    return query;
  }

  // ... that count as real sales / purchases (not Draft / Cancelled / Rejected)
  private counted(orgUID: number, branchUID: number, moduleUID: number): Knex.QueryBuilder {
    return this.scoped(orgUID, branchUID, moduleUID).whereNotIn("DocStatus", NOT_COUNTED);
  }
}

export const DASHBOARD_MODULES = { INVOICE, PURCHASE };
