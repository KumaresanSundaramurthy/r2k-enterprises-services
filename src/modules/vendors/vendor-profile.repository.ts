import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { MODULE_UID } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";
import { CiValidationError } from "../../core/response/ci-response";
import { Row } from "./vendors.repository";

const NOTES_TABLE = "VendorNotesTbl";
const RETURN_MODULES = [MODULE_UID.PurchaseReturns, MODULE_UID.DebitNotes];

/**
 * Vendor profile analytics and notes (CI3 Vendors_model profile section). Supplier documents are stored with
 * PartyType 'S' (the balance queries use it); CI3's profile queries filtered on 'V' and so never found any rows.
 */
@Injectable()
export class VendorProfileRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getVendorFinancialSummary — purchased, returned and days since the last document, in one pass.
  async financialSummary(orgUID: number, vendorUID: number): Promise<Row | null> {
    const result = await this.read.raw(
      `SELECT
         COALESCE(SUM(CASE WHEN ModuleUID = ${MODULE_UID.Purchases} AND DocStatus NOT IN ('Draft','Cancelled','Rejected') THEN NetAmount ELSE 0 END), 0) AS TotalPurchased,
         COALESCE(SUM(CASE WHEN ModuleUID IN (${RETURN_MODULES.join(",")}) AND DocStatus NOT IN ('Cancelled','Rejected') THEN NetAmount ELSE 0 END), 0) AS TotalReturned,
         DATEDIFF(CURDATE(), MAX(CASE WHEN DocStatus NOT IN ('Draft','Cancelled','Rejected') THEN TransDate END)) AS DaysSinceLastTx
       FROM \`Transaction\`.TransactionsTbl
       WHERE OrgUID = ? AND PartyUID = ? AND PartyType = 'S' AND IsDeleted = 0`,
      [orgUID, vendorUID]
    );
    return (result[0][0] as Row) ?? null;
  }

  // getVendorMonthlyPurchaseData — purchase total per month for the last 6 months
  async monthlyPurchases(orgUID: number, vendorUID: number): Promise<Row[]> {
    return this.read("Transaction.TransactionsTbl")
      .select(
        this.read.raw("DATE_FORMAT(??, '%b %Y') AS ??", ["TransDate", "MonthLabel"]),
        this.read.raw("DATE_FORMAT(??, '%Y-%m') AS ??", ["TransDate", "MonthKey"]),
        this.read.raw("COALESCE(SUM(??), 0) AS ??", ["NetAmount", "Total"])
      )
      .where({ OrgUID: orgUID, PartyUID: vendorUID, PartyType: "S", ModuleUID: MODULE_UID.Purchases, IsDeleted: 0 })
      .whereNotIn("DocStatus", ["Draft", "Cancelled", "Rejected"])
      .whereRaw("?? >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)", ["TransDate"])
      .groupByRaw("DATE_FORMAT(??, '%Y-%m'), DATE_FORMAT(??, '%b %Y')", ["TransDate", "TransDate"])
      .orderBy("MonthKey", "asc");
  }

  // getVendorRecentTransactions — latest documents of one module
  async recentTransactions(orgUID: number, vendorUID: number, moduleUID: number, limit: number): Promise<Row[]> {
    return this.read("Transaction.TransactionsTbl as Ts")
      .select(
        "Ts.TransUID as TransUID",
        "Ts.TransNumber as TransNo",
        "Ts.TransDate as DocDate",
        "Ts.NetAmount as NetAmount",
        "Ts.DocStatus as DocStatus",
        "Ts.BalanceAmount as BalanceAmount"
      )
      .where({ "Ts.OrgUID": orgUID, "Ts.PartyUID": vendorUID, "Ts.PartyType": "S", "Ts.ModuleUID": moduleUID, "Ts.IsDeleted": 0 })
      .orderBy("Ts.TransUID", "desc")
      .limit(limit);
  }

  // getVendorStatementData — purchases (credit), payments and returns (debit) in a date range, by date
  async statement(orgUID: number, vendorUID: number, fromDate: string, toDate: string): Promise<Row[]> {
    const raw = (sql: string) => this.read.raw(sql);
    const party = { OrgUID: orgUID, PartyUID: vendorUID, PartyType: "S", IsDeleted: 0 };
    const [purchases, payments, returns] = await Promise.all([
      this.read("Transaction.TransactionsTbl")
        .select(raw("'Purchase' AS TxType"), "TransNumber as RefNo", "TransDate as TxDate", raw("0 AS Debit"), "NetAmount as Credit", "DocStatus")
        .where({ ...party, ModuleUID: MODULE_UID.Purchases })
        .whereNotIn("DocStatus", ["Cancelled", "Rejected"])
        .whereBetween("TransDate", [fromDate, toDate]),
      this.read("Transaction.PaymentsTbl")
        .select(raw("'Payment' AS TxType"), raw("'' AS RefNo"), raw("DATE(PaymentDate) AS TxDate"), "Amount as Debit", raw("0 AS Credit"), raw("'Paid' AS DocStatus"))
        .where({ ...party, IsCancelled: 0 })
        .whereRaw("DATE(??) BETWEEN ? AND ?", ["PaymentDate", fromDate, toDate]),
      this.read("Transaction.TransactionsTbl")
        .select(raw("'Return' AS TxType"), "TransNumber as RefNo", "TransDate as TxDate", "NetAmount as Debit", raw("0 AS Credit"), "DocStatus")
        .where(party)
        .whereIn("ModuleUID", RETURN_MODULES)
        .whereNotIn("DocStatus", ["Cancelled", "Rejected"])
        .whereBetween("TransDate", [fromDate, toDate]),
    ]);
    return [...purchases, ...payments, ...returns].sort((a: Row, b: Row) => String(a.TxDate).localeCompare(String(b.TxDate)));
  }

  // getVendorNotes — newest first, with the author's name (none while Vendors.VendorNotesTbl does not exist, as in CI3)
  async notes(orgUID: number, vendorUID: number): Promise<Row[]> {
    if (!(await this.tableExists("Vendors", NOTES_TABLE))) return [];
    return this.read("Vendors.VendorNotesTbl as N")
      .select("N.NoteUID as NoteUID", "N.Note as Note", "N.CreatedOn as CreatedOn", this.read.raw("CONCAT(??, ' ', ??) AS ??", ["U.FirstName", "U.LastName", "UserName"]))
      .leftJoin("Users.UserTbl as U", "U.UserUID", "N.UserUID")
      .where({ "N.OrgUID": orgUID, "N.VendorUID": vendorUID, "N.IsDeleted": 0 })
      .orderBy("N.NoteUID", "desc");
  }

  // saveVendorNote
  async insertNote(orgUID: number, vendorUID: number, note: string, userUID: number): Promise<void> {
    if (!(await this.tableExists("Vendors", NOTES_TABLE))) throw new CiValidationError(`Table 'Vendors.${NOTES_TABLE}' doesn't exist`);
    await this.writer()("Vendors.VendorNotesTbl").insert({ OrgUID: orgUID, VendorUID: vendorUID, Note: note, UserUID: userUID, IsDeleted: 0 });
  }
}
