import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { MODULE_UID } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";

const TRANSACTIONS = "Transaction.TransactionsTbl";
const NOT_COUNTED = ["Draft", "Cancelled", "Rejected"];

export interface SalesSummary { thisMonth: number; thisCount: number; lastMonth: number }
export interface TodayActivity { total: number; invoices: number; purchases: number; payments: number }
export interface AssistantContext {
  sales: SalesSummary;
  receivable: number;
  payable: number;
  overdue: number;
  lowStock: number;
  topCustomers: { Name: string | null; total: string }[];
  topProducts: { ItemName: string | null; qty_sold: string }[];
  today: TodayActivity;
}

// Dates of the snapshot, in the organisation's timezone (Y-m-d)
export interface SnapshotDates { today: string; thisStart: string; lastStart: string; lastEnd: string }

/**
 * Assistant_model — the business snapshot sent to Gemini as context. Read-only; every sub-query is independent
 * and falls back to zero / empty on failure (as CI3), so one bad query never stops the assistant.
 */
@Injectable()
export class AssistantRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // What CI3 took from the session: org name (brand name first), currency symbol, AI switch, timezone, user's name
  async promptInfo(orgUID: number, userUID: number) {
    const [org, user] = await Promise.all([
      this.read("Organisation.OrganisationTbl as Org")
        .select("Org.Name", "Org.BrandName", "Settg.CurrenySymbol", "Settg.EnableAIAssistant", "Tz.Timezone")
        .leftJoin("Settings.OrgSettingsTbl as Settg", "Settg.OrgUID", "Org.OrgUID")
        .leftJoin("Global.TimezoneTbl as Tz", "Tz.TimezoneUID", "Org.TimezoneUID")
        .where({ "Org.OrgUID": orgUID, "Org.IsDeleted": 0 })
        .first(),
      this.read("Users.UserTbl").select("FirstName", "LastName").where({ UserUID: userUID, OrgUID: orgUID, IsDeleted: 0 }).first(),
    ]);
    if (!org) return null;
    return {
      orgName: String(org.BrandName || org.Name || ""),
      currency: String(org.CurrenySymbol || "₹"),
      aiEnabled: org.EnableAIAssistant === "Yes",
      timezone: String(org.Timezone || "UTC"),
      userName: user ? `${user.FirstName ?? ""} ${user.LastName ?? ""}`.trim() : "",
    };
  }

  async buildContext(orgUID: number, branchUID: number, dates: SnapshotDates): Promise<AssistantContext> {
    const [sales, receivable, payable, overdue, lowStock, topCustomers, topProducts, today] = await Promise.all([
      this.safe(() => this.salesSummary(orgUID, branchUID, dates), { thisMonth: 0, thisCount: 0, lastMonth: 0 }),
      this.safe(() => this.pendingBalance("Customers.CustOpeningBalanceTbl", "Debit", orgUID), 0),
      this.safe(() => this.pendingBalance("Vendors.VendOpeningBalanceTbl", "Credit", orgUID), 0),
      this.safe(() => this.overdueCount(orgUID, branchUID, dates.today), 0),
      this.safe(() => this.lowStockCount(orgUID), 0),
      this.safe(() => this.topCustomers(orgUID, branchUID, dates.thisStart), []),
      this.safe(() => this.topProducts(orgUID, branchUID, dates.thisStart), []),
      this.safe(() => this.todayActivity(orgUID, branchUID, dates.today), { total: 0, invoices: 0, purchases: 0, payments: 0 }),
    ]);
    return { sales, receivable, payable, overdue, lowStock, topCustomers, topProducts, today };
  }

  private async safe<T>(query: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await query();
    } catch {
      return fallback;
    }
  }

  private salesInvoices(qb: Knex.QueryBuilder, orgUID: number, branchUID: number, prefix = ""): Knex.QueryBuilder {
    qb.where({ [`${prefix}OrgUID`]: orgUID, [`${prefix}ModuleUID`]: MODULE_UID.Invoices, [`${prefix}IsDeleted`]: 0 }).whereNotIn(`${prefix}DocStatus`, NOT_COUNTED);
    if (branchUID > 0) qb.where(`${prefix}BranchUID`, branchUID);
    return qb;
  }

  // _getSalesSummary — invoices this month (amount and count) and last month
  private async salesSummary(orgUID: number, branchUID: number, d: SnapshotDates): Promise<SalesSummary> {
    const row = await this.salesInvoices(
      this.read(TRANSACTIONS).select(
        this.read.raw("COALESCE(SUM(CASE WHEN TransDate >= ? THEN NetAmount ELSE 0 END), 0) AS this_month", [d.thisStart]),
        this.read.raw("COUNT(CASE WHEN TransDate >= ? THEN 1 END) AS this_count", [d.thisStart]),
        this.read.raw("COALESCE(SUM(CASE WHEN TransDate BETWEEN ? AND ? THEN NetAmount ELSE 0 END), 0) AS last_month", [d.lastStart, d.lastEnd])
      ),
      orgUID,
      branchUID
    )
      .where("TransDate", ">=", d.lastStart)
      .first();
    return { thisMonth: Number(row?.this_month ?? 0), thisCount: Number(row?.this_count ?? 0), lastMonth: Number(row?.last_month ?? 0) };
  }

  // _getReceivable / _getPayable — outstanding opening balances (all branches)
  private async pendingBalance(table: string, balanceType: "Debit" | "Credit", orgUID: number): Promise<number> {
    const row = await this.read(table)
      .select(this.read.raw("COALESCE(SUM(PendingBalance), 0) AS total"))
      .where({ OrgUID: orgUID, PendingBalType: balanceType, IsDeleted: 0 })
      .where("PendingBalance", ">", 0)
      .first();
    return Number(row?.total ?? 0);
  }

  // _getOverdueCount — issued / partly paid invoices past their due date with a balance left
  private async overdueCount(orgUID: number, branchUID: number, today: string): Promise<number> {
    const qb = this.read(`${TRANSACTIONS} as T`)
      .select(this.read.raw("COUNT(*) AS cnt"))
      .leftJoin("Transaction.TransDetailTbl as D", (on) => on.on("D.TransUID", "T.TransUID").andOn(this.read.raw("D.FinancialYear = YEAR(T.TransDate)")))
      .where({ "T.OrgUID": orgUID, "T.ModuleUID": MODULE_UID.Invoices, "T.IsDeleted": 0 })
      .whereIn("T.DocStatus", ["Issued", "Partial"])
      .whereNotNull("D.ValidityDate")
      .where("D.ValidityDate", "<", today)
      .where("T.BalanceAmount", ">", 0);
    if (branchUID > 0) qb.where("T.BranchUID", branchUID);
    const row = await qb.first();
    return Number(row?.cnt ?? 0);
  }

  // _getLowStockCount — active products at or below their low-stock alert level
  private async lowStockCount(orgUID: number): Promise<number> {
    const row = await this.read("Products.ProductTbl as P")
      .select(this.read.raw("COUNT(*) AS cnt"))
      .leftJoin("Products.ProductStockTbl as PS", "PS.ProductUID", "P.ProductUID")
      .where({ "P.OrgUID": orgUID, "P.IsDeleted": 0, "P.IsActive": 1 })
      .where("P.LowStockAlertAt", ">", 0)
      .whereRaw("COALESCE(PS.AvailableQty, 0) <= P.LowStockAlertAt")
      .first();
    return Number(row?.cnt ?? 0);
  }

  // _getTopCustomers — top 5 customers by invoiced amount this month
  private async topCustomers(orgUID: number, branchUID: number, thisStart: string) {
    return this.salesInvoices(
      this.read(`${TRANSACTIONS} as T`)
        .select("C.Name", this.read.raw("COALESCE(SUM(T.NetAmount), 0) AS total"))
        .leftJoin("Customers.CustomerTbl as C", "C.CustomerUID", "T.PartyUID"),
      orgUID,
      branchUID,
      "T."
    )
      .where("T.PartyType", "C")
      .where("T.TransDate", ">=", thisStart)
      .groupBy("T.PartyUID")
      .orderBy("total", "desc")
      .limit(5);
  }

  // _getTopProducts — top 5 products by quantity invoiced this month
  private async topProducts(orgUID: number, branchUID: number, thisStart: string) {
    return this.salesInvoices(
      this.read("Transaction.TransProductsTbl as TI")
        .select("P.ItemName", this.read.raw("COALESCE(SUM(TI.Quantity), 0) AS qty_sold"))
        .join(`${TRANSACTIONS} as T`, "T.TransUID", "TI.TransUID")
        .leftJoin("Products.ProductTbl as P", "P.ProductUID", "TI.ProductUID"),
      orgUID,
      branchUID,
      "T."
    )
      .where("T.TransDate", ">=", thisStart)
      .groupBy("TI.ProductUID")
      .orderBy("qty_sold", "desc")
      .limit(5);
  }

  // _getTodayActivity — documents created today: every transaction, invoices, purchases, and payments (PaymentsTbl)
  private async todayActivity(orgUID: number, branchUID: number, today: string): Promise<TodayActivity> {
    const docs = this.read(TRANSACTIONS)
      .select(
        this.read.raw("COUNT(*) AS total"),
        this.read.raw("COUNT(CASE WHEN ModuleUID = ? THEN 1 END) AS invoices", [MODULE_UID.Invoices]),
        this.read.raw("COUNT(CASE WHEN ModuleUID = ? THEN 1 END) AS purchases", [MODULE_UID.Purchases])
      )
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .whereRaw("DATE(CreatedOn) = ?", [today]);
    const payments = this.read("Transaction.PaymentsTbl")
      .select(this.read.raw("COUNT(*) AS cnt"))
      .where({ OrgUID: orgUID, IsDeleted: 0, IsCancelled: 0 })
      .whereRaw("DATE(CreatedOn) = ?", [today]);
    if (branchUID > 0) {
      docs.where("BranchUID", branchUID);
      payments.where("BranchUID", branchUID);
    }
    const [docRow, payRow] = await Promise.all([docs.first(), payments.first()]);
    const paymentCount = Number(payRow?.cnt ?? 0);
    return {
      total: Number(docRow?.total ?? 0) + paymentCount,
      invoices: Number(docRow?.invoices ?? 0),
      purchases: Number(docRow?.purchases ?? 0),
      payments: paymentCount,
    };
  }
}
