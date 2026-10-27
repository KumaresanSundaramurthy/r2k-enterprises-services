import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { MODULE_UID } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";
import { Row } from "./customers.repository";

// Invoice statuses that count as real sales (Draft, Cancelled and Rejected do not)
const INACTIVE_STATUSES = ["Draft", "Cancelled", "Rejected"];

// Customer profile analytics (CI3 Customers_model profile section). All read-only.
@Injectable()
export class CustomerProfileRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getCustomerFinancialSummary — invoiced, collected, returned, overdue count, last activity and ageing buckets in one pass.
  async financialSummary(orgUID: number, customerUID: number): Promise<Row | null> {
    const inv = MODULE_UID.Invoices;
    const outstanding = `ModuleUID = ${inv} AND DocStatus IN ('Issued','Partial') AND BalanceAmount > 0`;
    const result = await this.read.raw(
      `SELECT
         COALESCE(SUM(CASE WHEN ModuleUID = ${inv} AND DocStatus NOT IN ('Draft','Cancelled','Rejected') THEN NetAmount ELSE 0 END), 0) AS TotalInvoiced,
         COALESCE(SUM(CASE WHEN ModuleUID = ${inv} AND DocStatus NOT IN ('Draft','Cancelled','Rejected') THEN (NetAmount - BalanceAmount) ELSE 0 END), 0) AS TotalCollected,
         COALESCE(SUM(CASE WHEN ModuleUID IN (${MODULE_UID.SalesReturns}, ${MODULE_UID.CreditNotes}) AND DocStatus NOT IN ('Cancelled','Rejected') THEN COALESCE(BalanceAmount, NetAmount) ELSE 0 END), 0) AS TotalReturned,
         COALESCE(SUM(CASE WHEN ${outstanding} AND TransDate < DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END), 0) AS OverdueCount,
         MAX(CASE WHEN DocStatus NOT IN ('Draft','Cancelled','Rejected') THEN TransDate ELSE NULL END) AS LastTxDate,
         COALESCE(SUM(CASE WHEN ${outstanding} AND DATEDIFF(CURDATE(), TransDate) BETWEEN 0 AND 30 THEN BalanceAmount ELSE 0 END), 0) AS Bucket_0_30,
         COALESCE(SUM(CASE WHEN ${outstanding} AND DATEDIFF(CURDATE(), TransDate) BETWEEN 31 AND 60 THEN BalanceAmount ELSE 0 END), 0) AS Bucket_31_60,
         COALESCE(SUM(CASE WHEN ${outstanding} AND DATEDIFF(CURDATE(), TransDate) BETWEEN 61 AND 90 THEN BalanceAmount ELSE 0 END), 0) AS Bucket_61_90,
         COALESCE(SUM(CASE WHEN ${outstanding} AND DATEDIFF(CURDATE(), TransDate) > 90 THEN BalanceAmount ELSE 0 END), 0) AS Bucket_90Plus
       FROM \`Transaction\`.TransactionsTbl
       WHERE OrgUID = ? AND PartyUID = ? AND PartyType = 'C' AND IsDeleted = 0`,
      [orgUID, customerUID]
    );
    return (result[0][0] as Row) ?? null;
  }

  // getMonthlySalesData — invoiced total per month for the last 6 months
  async monthlySales(orgUID: number, customerUID: number): Promise<Row[]> {
    return this.read("Transaction.TransactionsTbl")
      .select(
        this.read.raw("DATE_FORMAT(??, '%b %Y') AS ??", ["TransDate", "MonthLabel"]),
        this.read.raw("DATE_FORMAT(??, '%Y-%m') AS ??", ["TransDate", "MonthKey"]),
        this.read.raw("COALESCE(SUM(??), 0) AS ??", ["NetAmount", "Total"])
      )
      .where({ OrgUID: orgUID, PartyUID: customerUID, PartyType: "C", ModuleUID: MODULE_UID.Invoices, IsDeleted: 0 })
      .whereNotIn("DocStatus", INACTIVE_STATUSES)
      .whereRaw("?? >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)", ["TransDate"])
      .groupByRaw("DATE_FORMAT(??, '%Y-%m'), DATE_FORMAT(??, '%b %Y')", ["TransDate", "TransDate"])
      .orderBy("MonthKey", "asc");
  }

  // getCustomerRecentTransactions — latest documents of one module
  async recentTransactions(orgUID: number, customerUID: number, moduleUID: number, limit: number): Promise<Row[]> {
    return this.read("Transaction.TransactionsTbl as Ts")
      .select(
        "Ts.TransUID as TransUID",
        "Ts.TransNumber as TransNo",
        "Ts.TransDate as DocDate",
        "Ts.NetAmount as NetAmount",
        "Ts.DocStatus as DocStatus",
        "Ts.BalanceAmount as BalanceAmount"
      )
      .where({ "Ts.OrgUID": orgUID, "Ts.PartyUID": customerUID, "Ts.PartyType": "C", "Ts.ModuleUID": moduleUID, "Ts.IsDeleted": 0 })
      .orderBy("Ts.TransUID", "desc")
      .limit(limit);
  }

  // getCustomerStatementData — invoices (debit), receipts and sales returns (credit) in a date range, by date
  async statement(orgUID: number, customerUID: number, fromDate: string, toDate: string): Promise<Row[]> {
    const raw = (sql: string) => this.read.raw(sql);
    const party = { OrgUID: orgUID, PartyUID: customerUID, PartyType: "C", IsDeleted: 0 };
    const [invoices, receipts, returns] = await Promise.all([
      this.read("Transaction.TransactionsTbl")
        .select(raw("'Invoice' AS TxType"), "TransNumber as RefNo", "TransDate as TxDate", "NetAmount as Debit", raw("0 AS Credit"), "DocStatus")
        .where({ ...party, ModuleUID: MODULE_UID.Invoices })
        .whereNotIn("DocStatus", ["Cancelled", "Rejected"])
        .whereBetween("TransDate", [fromDate, toDate]),
      this.read("Transaction.PaymentsTbl")
        .select(raw("'Receipt' AS TxType"), raw("'' AS RefNo"), raw("DATE(PaymentDate) AS TxDate"), raw("0 AS Debit"), "Amount as Credit", raw("'Paid' AS DocStatus"))
        .where({ ...party, PaymentDirection: "In", IsCancelled: 0, IsTransferredToCreditNote: 0 })
        .whereRaw("DATE(??) BETWEEN ? AND ?", ["PaymentDate", fromDate, toDate]),
      this.read("Transaction.TransactionsTbl")
        .select(raw("'Return' AS TxType"), "TransNumber as RefNo", "TransDate as TxDate", raw("0 AS Debit"), "NetAmount as Credit", "DocStatus")
        .where({ ...party, ModuleUID: MODULE_UID.SalesReturns })
        .whereNotIn("DocStatus", ["Cancelled", "Rejected"])
        .whereBetween("TransDate", [fromDate, toDate]),
    ]);
    return [...invoices, ...receipts, ...returns].sort((a: Row, b: Row) => String(a.TxDate).localeCompare(String(b.TxDate)));
  }

  // getCustomerNotes — newest first, with the author's name
  async notes(orgUID: number, customerUID: number): Promise<Row[]> {
    return this.read("Customers.CustomerNotesTbl as N")
      .select("N.NoteUID as NoteUID", "N.Note as Note", "N.CreatedOn as CreatedOn", this.read.raw("CONCAT(??, ' ', ??) AS ??", ["U.FirstName", "U.LastName", "UserName"]))
      .leftJoin("Users.UserTbl as U", "U.UserUID", "N.UserUID")
      .where({ "N.OrgUID": orgUID, "N.CustomerUID": customerUID, "N.IsDeleted": 0 })
      .orderBy("N.NoteUID", "desc");
  }

  // getCustomerProfitability — estimated cost of goods sold at today's purchase prices
  async costOfGoodsSold(orgUID: number, customerUID: number): Promise<number> {
    const row = await this.read("Transaction.TransactionsTbl as Ts")
      .select(this.read.raw("COALESCE(SUM(?? * ??), 0) AS ??", ["Tp.Quantity", "P.PurchasePrice", "COGS"]))
      .join("Transaction.TransProductsTbl as Tp", (on) => {
        on.on("Tp.TransUID", "Ts.TransUID").andOnVal("Tp.IsDeleted", "=", 0);
      })
      .leftJoin("Products.ProductTbl as P", (on) => {
        on.on("P.ProductUID", "Tp.ProductUID").andOnVal("P.IsDeleted", "=", 0);
      })
      .where({ "Ts.OrgUID": orgUID, "Ts.PartyUID": customerUID, "Ts.PartyType": "C", "Ts.ModuleUID": MODULE_UID.Invoices, "Ts.IsDeleted": 0 })
      .whereNotIn("Ts.DocStatus", INACTIVE_STATUSES)
      .first();
    return Number(row?.COGS ?? 0);
  }
}
