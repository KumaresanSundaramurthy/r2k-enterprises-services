import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

const TRANSACTIONS = "Transaction.TransactionsTbl";
const CONVERSIONS = "Transaction.TransConversionTbl";

/** Sales-side reads and links (CI3 Transactions_model / Dbwrite_ext_model invoice, sales-return and challan helpers). */
@Injectable()
export class SalesRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // TransSettings.InvoiceCancelAction — what happens to a cancelled / deleted invoice's payments (ask, credit_note, refund, cancel_only)
  async invoiceCancelAction(orgUID: number): Promise<string> {
    const row = await this.read("Settings.TransactionSettingsTbl").select("InvoiceCancelAction").where({ OrgUID: orgUID }).first();
    return String(row?.InvoiceCancelAction || "ask");
  }

  // getTransDetailRow — the document's detail row (org-scoped through its header; CI3 matched TransUID alone)
  async detailRow(orgUID: number, transUID: number): Promise<Row | null> {
    const row = await this.read("Transaction.TransDetailTbl as Td")
      .select("Td.IsInterState", "Td.PendingCreditNoteUID")
      .join(`${TRANSACTIONS} as Ts`, "Ts.TransUID", "Td.TransUID")
      .where({ "Td.TransUID": transUID, "Ts.OrgUID": orgUID })
      .first();
    return row ?? null;
  }

  // hasActiveSalesReturns / hasSalesReturnAgainstTrans — a live, not cancelled sales return holds lines of the invoice
  async hasSalesReturns(orgUID: number, transUID: number): Promise<boolean> {
    const [rows] = await this.read.raw(
      `SELECT RP.TransProdUID FROM Transaction.TransProductsTbl RP
        INNER JOIN Transaction.TransactionsTbl RTP ON RTP.TransUID = RP.TransUID
        WHERE RP.SourceTransProdUID IN (SELECT TransProdUID FROM Transaction.TransProductsTbl WHERE TransUID = ? AND IsDeleted = 0 AND IsActive = 1)
          AND RTP.ModuleUID = 106 AND RTP.OrgUID = ? AND RTP.IsDeleted = 0 AND RTP.IsCancelled = 0
          AND RP.IsDeleted = 0 AND RP.IsActive = 1
        LIMIT 1`,
      [transUID, orgUID]
    );
    return (rows as Row[]).length > 0;
  }

  // getCustomerInvoicesWithReturnableItems — the customer's saved invoices with a line not fully returned
  async returnableInvoices(orgUID: number, customerUID: number, excludeTransUID: number): Promise<Row[]> {
    const exclude = excludeTransUID > 0 ? "AND RP.TransUID != ?" : "";
    const [rows] = await this.read.raw(
      `SELECT Ts.TransUID, Ts.UniqueNumber, Ts.TransDate, Ts.NetAmount, Ts.DocStatus
         FROM Transaction.TransactionsTbl AS Ts
        WHERE Ts.PartyUID = ? AND Ts.PartyType = 'C' AND Ts.ModuleUID = 103 AND Ts.OrgUID = ?
          AND Ts.IsDeleted = 0 AND Ts.IsActive = 1 AND Ts.DocStatus NOT IN ('Draft', 'Cancelled')
          AND EXISTS (
              SELECT 1 FROM Transaction.TransProductsTbl AS IP
               WHERE IP.TransUID = Ts.TransUID AND IP.OrgUID = Ts.OrgUID AND IP.IsDeleted = 0 AND IP.IsActive = 1
                 AND IP.Quantity > COALESCE((
                     SELECT SUM(RP.Quantity) FROM Transaction.TransProductsTbl AS RP
                      WHERE RP.SourceTransProdUID = IP.TransProdUID AND RP.OrgUID = Ts.OrgUID AND RP.IsDeleted = 0 AND RP.IsActive = 1 ${exclude}
                 ), 0))
        ORDER BY Ts.TransUID DESC`,
      excludeTransUID > 0 ? [customerUID, orgUID, excludeTransUID] : [customerUID, orgUID]
    );
    return rows as Row[];
  }

  // getPendingInvoicesForCustomer — the customer's invoices with a balance still to receive
  pendingInvoices(orgUID: number, customerUID: number): Promise<Row[]> {
    return this.read(`${TRANSACTIONS} as Ts`)
      .select("Ts.TransUID", "Ts.UniqueNumber", "Ts.TransDate", "Ts.NetAmount", this.read.raw("COALESCE(Ts.PaidAmount, 0) AS PaidAmount"), this.read.raw("COALESCE(Ts.BalanceAmount, 0) AS BalanceAmount"))
      .where({ "Ts.PartyUID": customerUID, "Ts.PartyType": "C", "Ts.ModuleUID": 103, "Ts.OrgUID": orgUID, "Ts.IsDeleted": 0, "Ts.IsActive": 1 })
      .whereNotIn("Ts.DocStatus", ["Draft", "Cancelled", "Paid"])
      .whereRaw("COALESCE(Ts.BalanceAmount, Ts.NetAmount) > 0")
      .orderBy("Ts.TransUID", "desc");
  }

  // ── Invoice ↔ sales return links (TransConversionTbl) ─────────────────

  // getActiveSourceInvoiceUIDs — the invoices the return's live lines come from
  async sourceInvoiceUIDs(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<number[]> {
    const rows: Row[] = await trx("Transaction.TransProductsTbl as sr")
      .distinct("src.TransUID")
      .join("Transaction.TransProductsTbl as src", "src.TransProdUID", "sr.SourceTransProdUID")
      .where({ "sr.TransUID": transUID, "sr.OrgUID": orgUID, "sr.IsDeleted": 0, "sr.IsActive": 1, "src.IsDeleted": 0 });
    return rows.map((row) => Number(row.TransUID));
  }

  // softDeleteSalesReturnConversionLinks — links to invoices the return no longer draws from
  async dropReturnLinks(trx: Knex.Transaction, orgUID: number, transUID: number, keepSourceUIDs: number[], userUID: number): Promise<void> {
    const query = trx(CONVERSIONS).where({ TargetTransUID: transUID, OrgUID: orgUID, IsDeleted: 0 });
    if (keepSourceUIDs.length > 0) query.whereNotIn("SourceTransUID", keepSourceUIDs);
    await query.update({ IsDeleted: 1, UpdatedBy: userUID });
  }

  // getConversionRecord
  async conversion(trx: Knex.Transaction, orgUID: number, sourceUID: number, targetUID: number): Promise<Row | null> {
    return (await trx(CONVERSIONS).select("ConversionUID", "IsDeleted").where({ SourceTransUID: sourceUID, TargetTransUID: targetUID, OrgUID: orgUID }).first()) ?? null;
  }

  async restoreConversion(trx: Knex.Transaction, conversionUID: number, userUID: number): Promise<void> {
    await trx(CONVERSIONS).where({ ConversionUID: conversionUID }).update({ IsDeleted: 0, IsCancelled: 0, UpdatedBy: userUID });
  }

  // markConversionDeleted / markConversionCancelled — the links into a removed / cancelled document
  async retireConversions(trx: Knex.Transaction, orgUID: number, targetUID: number, mode: "delete" | "cancel", userUID: number): Promise<void> {
    if (mode === "delete") await trx(CONVERSIONS).where({ TargetTransUID: targetUID, OrgUID: orgUID, IsDeleted: 0 }).update({ IsDeleted: 1, UpdatedBy: userUID });
    else await trx(CONVERSIONS).where({ TargetTransUID: targetUID, OrgUID: orgUID, IsCancelled: 0, IsDeleted: 0 }).update({ IsCancelled: 1, UpdatedBy: userUID });
  }

  // ── Delivery challan partial returns (DCReturnItemsTbl) ───────────────

  // getDCReturnedQty — quantity returned so far per challan line
  async challanReturned(orgUID: number, transUID: number, trx?: Knex.Transaction): Promise<Map<number, number>> {
    const rows: Row[] = await (trx ?? this.read)("Transaction.DCReturnItemsTbl")
      .select("TransProdUID")
      .sum("ReturnedQty as TotalReturned")
      .where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 })
      .groupBy("TransProdUID");
    return new Map(rows.map((row) => [Number(row.TransProdUID), Number(row.TotalReturned ?? 0)]));
  }

  async insertChallanReturn(trx: Knex.Transaction, row: Row): Promise<void> {
    await trx("Transaction.DCReturnItemsTbl").insert(row);
  }

  transaction<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.db.write.transaction(work);
  }
}
