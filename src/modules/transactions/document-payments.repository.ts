import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

const PAYMENTS = "Transaction.PaymentsTbl";
const TRANSACTIONS = "Transaction.TransactionsTbl";
const DEBIT_NOTES = "Transaction.TransDebitNoteTbl";
const CREDIT_NOTES = "Transaction.TransCreditNoteTbl";

/*
 * Payments of the document itself. Expense / indirect-income payments keep their own record's UID in TransUID,
 * so they are left out (CI3 matched TransUID alone, and touched them when the numbers collided).
 */
const OWN = "(SourceType IS NULL OR SourceType NOT IN ('Expense', 'IndirectIncome'))";

/**
 * Payments, refunds and debit notes of the transaction documents (CI3 Transactions_model / Dbwrite_ext_model
 * payment helpers). Writes run inside the caller's transaction.
 */
@Injectable()
export class DocumentPaymentsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // A write transaction for payment / debit-note work that follows a document's own commit
  transaction<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.db.write.transaction(work);
  }

  async insertPayment(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx(PAYMENTS).insert(row);
    return Number(id);
  }

  // getNextPaymentNumber — one above the year's highest on the prefix, skipping numbers a live payment holds
  async nextPaymentNumber(trx: Knex.Transaction, orgUID: number, prefixUID: number, transYear: number): Promise<number> {
    const scope = { PrefixUID: prefixUID, OrgUID: orgUID, TransYear: transYear };
    const row = await trx(PAYMENTS).max("PaymentNumber as MaxNumber").where(scope).first();
    let next = Number(row?.MaxNumber ?? 0) + 1;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await trx(PAYMENTS).select("PaymentUID").where({ ...scope, PaymentNumber: next, IsDeleted: 0 }).first())) break;
      next++;
    }
    return next;
  }

  // lockTransactionRow — the document row is held until the payment is saved
  async lockDocument(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<boolean> {
    return !!(await trx(TRANSACTIONS).select("TransUID").where({ TransUID: transUID, OrgUID: orgUID }).forUpdate().first());
  }

  // sumTransactionPayments — live payments of the document
  async paidTotal(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<number> {
    const row = await trx(PAYMENTS).sum("Amount as TotalPaid").where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0, IsActive: 1, IsCancelled: 0 }).whereRaw(OWN).first();
    return Number(row?.TotalPaid ?? 0);
  }

  // updateTransIsFullyPaid
  async setPaid(trx: Knex.Transaction, orgUID: number, transUID: number, paid: { isFullyPaid: number; paidAmount: number; balanceAmount: number }, userUID: number): Promise<void> {
    await trx(TRANSACTIONS)
      .where({ TransUID: transUID, OrgUID: orgUID })
      .update({ IsFullyPaid: paid.isFullyPaid, PaidAmount: paid.paidAmount, BalanceAmount: paid.balanceAmount, UpdatedBy: userUID });
  }

  // updateTransDocStatus
  async setDocStatus(trx: Knex.Transaction, orgUID: number, transUID: number, status: string, userUID: number): Promise<void> {
    await trx(TRANSACTIONS).where({ TransUID: transUID, OrgUID: orgUID }).update({ DocStatus: status, UpdatedBy: userUID, UpdatedOn: trx.fn.now() });
  }

  // getPaymentAttachments of several payments, each file with its CDN URL
  async paymentAttachments(orgUID: number, paymentUIDs: number[]): Promise<Row[]> {
    if (paymentUIDs.length === 0) return [];
    const rows: Row[] = await this.read("Transaction.PaymentAttachmentsTbl")
      .select("AttachUID", "PaymentUID", "FileName", "FilePath", "FileType", "FileSize", "CreatedOn")
      .whereIn("PaymentUID", paymentUIDs)
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .orderBy([{ column: "PaymentUID" }, { column: "SortOrder" }, { column: "AttachUID" }]);
    return rows.map((row) => ({ ...row, Url: resolveCdnUrl(row.FilePath as string) }));
  }

  // hasDebitNoteApplied — a debit-note credit (PaymentTypeUID 0) was paid against the bill
  async hasDebitNoteApplied(orgUID: number, transUID: number): Promise<boolean> {
    return !!(await this.read(PAYMENTS).select("PaymentUID").where({ TransUID: transUID, OrgUID: orgUID, PaymentTypeUID: 0, PartyType: "S", IsDeleted: 0, IsCancelled: 0 }).whereRaw(OWN).first());
  }

  // markVendorPaymentsDeletedForTrans / markVendorPaymentsCancelledForTrans — the payments made to the vendor for a bill
  async voidVendorPayments(trx: Knex.Transaction, orgUID: number, transUID: number, mode: "delete" | "cancel", userUID: number): Promise<void> {
    const query = trx(PAYMENTS).where({ TransUID: transUID, OrgUID: orgUID, PartyType: "S", PaymentDirection: "Out", IsDeleted: 0 }).whereRaw(OWN);
    if (mode === "delete") await query.update({ IsDeleted: 1, UpdatedBy: userUID });
    else await query.where("IsCancelled", 0).update({ IsCancelled: 1, UpdatedBy: userUID });
  }

  // cancelRefundPaymentsForTrans / deleteRefundPaymentsForTrans — the cash refunds of a return (debit adjustments stay)
  async voidRefunds(trx: Knex.Transaction, orgUID: number, transUID: number, mode: "cancel" | "delete", userUID: number): Promise<void> {
    const query = trx(PAYMENTS).where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 }).whereNot("PaymentTypeUID", 0).whereRaw(OWN);
    if (mode === "cancel") await query.update({ IsCancelled: 1, UpdatedBy: userUID });
    else await query.update({ IsDeleted: 1, IsActive: 0, UpdatedBy: userUID });
  }

  // getPRTotalRefunded — cash / bank refunds received against a return
  async refundedTotal(orgUID: number, transUID: number): Promise<number> {
    const row = await this.read(PAYMENTS)
      .sum("Amount as Total")
      .where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 })
      .whereNot("PaymentTypeUID", 0)
      .whereRaw("IFNULL(IsCancelled, 0) != 1")
      .whereRaw(OWN)
      .first();
    return Number(row?.Total ?? 0);
  }

  // getPRCancelDepsMap — refunds per return
  async refundedTotals(orgUID: number, transUIDs: number[]): Promise<Map<number, number>> {
    if (transUIDs.length === 0) return new Map();
    const rows: Row[] = await this.read(PAYMENTS)
      .select("TransUID")
      .sum("Amount as Total")
      .whereIn("TransUID", transUIDs)
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .whereNot("PaymentTypeUID", 0)
      .whereRaw("IFNULL(IsCancelled, 0) != 1")
      .whereRaw(OWN)
      .groupBy("TransUID");
    return new Map(rows.map((row) => [Number(row.TransUID), Number(row.Total ?? 0)]));
  }

  // ── Debit notes (TransDebitNoteTbl, vendor side) ──────────────────────

  // getVendorDebitNote — a live vendor debit note
  async vendorDebitNote(orgUID: number, debitNoteUID: number, trx?: Knex.Transaction): Promise<Row | null> {
    const row = await (trx ?? this.read)(DEBIT_NOTES)
      .select("DebitNoteUID", "PartyUID", "Amount", "Status", "SourceTransNumber")
      .where({ DebitNoteUID: debitNoteUID, OrgUID: orgUID, PartyType: "S", IsCancelled: 0, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getVendorAvailableDebitNotes — the vendor's Pending notes with a balance left
  availableDebitNotes(orgUID: number, vendorUID: number): Promise<Row[]> {
    return this.read(DEBIT_NOTES)
      .select("DebitNoteUID", "SourceTransNumber", "Amount", "Status", "Notes", "SourceModuleUID")
      .where({ OrgUID: orgUID, PartyUID: vendorUID, PartyType: "S", Status: "Pending", IsCancelled: 0, IsDeleted: 0 })
      .where("Amount", ">", 0)
      .orderBy("DebitNoteUID", "asc");
  }

  // getDebitNoteByUID
  async debitNote(orgUID: number, debitNoteUID: number, excludeCancelled: boolean): Promise<Row | null> {
    const query = this.read(DEBIT_NOTES)
      .select("DebitNoteUID", "PartyUID", "PartyType", "SourceTransUID", "SourceTransNumber", "SourceModuleUID", "Amount", "Status")
      .where({ DebitNoteUID: debitNoteUID, OrgUID: orgUID, IsDeleted: 0 });
    if (excludeCancelled) query.where("IsCancelled", 0);
    return (await query.first()) ?? null;
  }

  // getDebitNotesList — the vendor debit notes tab
  async debitNotes(orgUID: number, limit: number, offset: number, status: string, search: string): Promise<{ total: number; rows: Row[] }> {
    const base = () => {
      const query = this.read(`${DEBIT_NOTES} as DN`)
        .leftJoin("Vendors.VendorTbl as V", "V.VendorUID", "DN.PartyUID")
        .where({ "DN.OrgUID": orgUID, "DN.PartyType": "S", "DN.IsDeleted": 0, "DN.IsCancelled": 0 });
      if (status && status !== "All") query.where("DN.Status", status);
      if (search) this.whereAnyLike(query, ["DN.SourceTransNumber", "V.Name"], search);
      return query;
    };
    const counted = await base().count("* as total").first();
    const rows: Row[] = await base()
      .select(
        "DN.DebitNoteUID",
        "DN.SourceTransUID",
        "DN.SourceTransNumber",
        "DN.SourceModuleUID",
        "DN.Amount",
        "DN.Status",
        "DN.Notes",
        "DN.CreatedOn",
        "V.VendorUID",
        "V.Name as VendorName",
        "V.Image as VendorImage",
        this.read.raw("CONCAT(U.FirstName, ' ', U.LastName) AS CreatorName")
      )
      .leftJoin("Users.UserTbl as U", "U.UserUID", "DN.CreatedBy")
      .orderBy("DN.DebitNoteUID", "desc")
      .limit(limit)
      .offset(offset);
    return { total: Number(counted?.total ?? 0), rows: rows.map((row) => ({ ...row, VendorImageUrl: resolveCdnUrl(row.VendorImage as string) })) };
  }

  async insertDebitNote(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx(DEBIT_NOTES).insert(row);
    return Number(id);
  }

  async updateDebitNote(trx: Knex.Transaction, orgUID: number, debitNoteUID: number, data: Row): Promise<void> {
    await trx(DEBIT_NOTES).where({ DebitNoteUID: debitNoteUID, OrgUID: orgUID }).update(data);
  }

  // The Pending debit note a purchase return raised for itself is cancelled with the return
  async cancelReturnDebitNotes(trx: Knex.Transaction, orgUID: number, transUID: number, userUID: number): Promise<void> {
    await trx(DEBIT_NOTES)
      .where({ SourceTransUID: transUID, SourceModuleUID: 108, Status: "Pending", IsCancelled: 0, IsDeleted: 0, OrgUID: orgUID })
      .update({ IsCancelled: 1, UpdatedBy: userUID });
  }

  async insertCreditNote(trx: Knex.Transaction, row: Row): Promise<void> {
    await trx("Transaction.TransCreditNoteTbl").insert(row);
  }

  // ── Customer side (invoices, sales returns) ──────────────────────────

  // getSRCreditApplied / getSRCancelDepsMap — credit adjustments (PaymentTypeUID 0) on invoices quoting the return's number
  async creditAppliedByNumbers(orgUID: number, numbers: string[]): Promise<Map<string, number>> {
    if (numbers.length === 0) return new Map();
    const rows: Row[] = await this.read(PAYMENTS)
      .select("ReferenceNo")
      .sum("Amount as Total")
      .whereIn("ReferenceNo", numbers)
      .where({ OrgUID: orgUID, PaymentTypeUID: 0, PaymentDirection: "In", IsDeleted: 0 })
      .groupBy("ReferenceNo");
    return new Map(rows.map((row) => [String(row.ReferenceNo), Number(row.Total ?? 0)]));
  }

  // getSRCreditPayments
  creditPaymentsByNumber(trx: Knex.Transaction, orgUID: number, number: string): Promise<Row[]> {
    return trx(PAYMENTS).select("PaymentUID", "TransUID", "Amount").where({ OrgUID: orgUID, ReferenceNo: number, PaymentTypeUID: 0, PaymentDirection: "In", IsDeleted: 0 });
  }

  /**
   * The customer payments received for an invoice: delete (markPaymentsDeletedForTrans), refund = cancel
   * (markPaymentsRefunded) or hold them as on-account credit (markPaymentsOnAccount).
   */
  async settleCustomerPayments(trx: Knex.Transaction, orgUID: number, transUID: number, mode: "delete" | "refund" | "onAccount", userUID: number): Promise<void> {
    const query = trx(PAYMENTS).where({ TransUID: transUID, OrgUID: orgUID, PartyType: "C", PaymentDirection: "In", IsDeleted: 0 }).whereRaw(OWN);
    if (mode === "delete") await query.update({ IsDeleted: 1, UpdatedBy: userUID });
    else if (mode === "refund") await query.update({ IsCancelled: 1, UpdatedBy: userUID });
    else await query.where("IsCancelled", 0).update({ IsOnAccount: 1, UpdatedBy: userUID });
  }

  // Every live payment of the document is cancelled (invoice cancel with Mark Refund) or deleted (sales return delete)
  async voidAllPayments(trx: Knex.Transaction, orgUID: number, transUID: number, mode: "cancel" | "delete", userUID: number): Promise<void> {
    const query = trx(PAYMENTS).where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 }).whereRaw(OWN);
    if (mode === "cancel") await query.update({ IsCancelled: 1, UpdatedBy: userUID });
    else await query.update({ IsDeleted: 1, IsActive: 0, UpdatedBy: userUID });
  }

  async updatePayment(trx: Knex.Transaction, orgUID: number, paymentUID: number, data: Row): Promise<void> {
    await trx(PAYMENTS).where({ PaymentUID: paymentUID, OrgUID: orgUID }).update(data);
  }

  // getOnAccountPayment — an unapplied on-account payment
  async onAccountPayment(trx: Knex.Transaction, orgUID: number, paymentUID: number): Promise<Row | null> {
    return (await trx(PAYMENTS).select("PaymentUID", "PartyUID", "Amount").where({ PaymentUID: paymentUID, OrgUID: orgUID, IsOnAccount: 1, IsDeleted: 0, IsCancelled: 0 }).first()) ?? null;
  }

  // lockOnAccountSourcePayment — the customer's on-account payment with a balance, held until commit
  async lockOnAccountSource(trx: Knex.Transaction, orgUID: number, paymentUID: number, partyUID: number): Promise<Row | null> {
    return (
      (await trx(PAYMENTS)
        .select("PaymentUID", "Amount")
        .where({ PaymentUID: paymentUID, OrgUID: orgUID, PartyUID: partyUID, IsOnAccount: 1, IsDeleted: 0, IsCancelled: 0 })
        .where("Amount", ">", 0)
        .forUpdate()
        .first()) ?? null
    );
  }

  // The customer's payment whose ExcessAmount (advance) is being used, held until commit
  async lockAdvanceSource(trx: Knex.Transaction, orgUID: number, paymentUID: number, partyUID: number): Promise<Row | null> {
    return (
      (await trx(PAYMENTS)
        .select("PaymentUID", "ExcessAmount", "IsDeleted", "IsCancelled")
        .where({ PaymentUID: paymentUID, OrgUID: orgUID, PartyUID: partyUID, PartyType: "C" })
        .forUpdate()
        .first()) ?? null
    );
  }

  // hasOnAccountPaymentApplied
  async hasOnAccountApplied(orgUID: number, transUID: number): Promise<boolean> {
    return !!(await this.read(PAYMENTS).select("PaymentUID").where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0, IsCancelled: 0 }).where("OnAccountSourcePaymentUID", ">", 0).first());
  }

  // hasCreditNotePaymentApplied (org-scoped; CI3 matched TransUID alone)
  async hasCreditNoteApplied(orgUID: number, transUID: number): Promise<boolean> {
    return !!(await this.read(PAYMENTS).select("PaymentUID").where({ TransUID: transUID, OrgUID: orgUID, SourceType: "CreditNote", IsDeleted: 0, IsCancelled: 0 }).first());
  }

  // hasExcessAppliedToTrans — an advance from another payment was used on this document
  async hasExcessAppliedTo(orgUID: number, transUID: number): Promise<boolean> {
    return !!(await this.read(PAYMENTS).select("PaymentUID").where({ TransUID: transUID, OrgUID: orgUID, IsExcessApplied: 1, IsDeleted: 0, IsCancelled: 0 }).first());
  }

  // hasExcessFromTrans — this document's overpayment is in use as an advance elsewhere
  async hasExcessFrom(orgUID: number, transUID: number): Promise<boolean> {
    return !!(await this.read(`${PAYMENTS} as src`)
      .select("linked.TransUID")
      .join(`${PAYMENTS} as linked`, "linked.ExcessSourcePaymentUID", "src.PaymentUID")
      .where({ "src.TransUID": transUID, "src.OrgUID": orgUID, "src.IsDeleted": 0, "src.IsCancelled": 0, "linked.IsDeleted": 0, "linked.IsCancelled": 0 })
      .first());
  }

  // ── Credit notes (TransCreditNoteTbl, customer side) and customer debit notes ──

  // getNextCreditNoteNumber / getNextDebitNoteNumber — org-wide sequence, never re-issued
  async nextNoteSeq(trx: Knex.Transaction, table: "credit" | "debit", orgUID: number): Promise<number> {
    const [tbl, col] = table === "credit" ? [CREDIT_NOTES, "CreditNoteSeq"] : [DEBIT_NOTES, "DebitNoteSeq"];
    const row = await trx(tbl).max(`${col} as MaxSeq`).where({ OrgUID: orgUID }).first();
    return Number(row?.MaxSeq ?? 0) + 1;
  }

  async insertCustomerCreditNote(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx(CREDIT_NOTES).insert(row);
    return Number(id);
  }

  async updateCreditNote(trx: Knex.Transaction, orgUID: number, creditNoteUID: number, data: Row): Promise<void> {
    await trx(CREDIT_NOTES).where({ CreditNoteUID: creditNoteUID, OrgUID: orgUID }).update(data);
  }

  // getCreditNoteByUID
  async creditNote(orgUID: number, creditNoteUID: number, excludeCancelled = false, trx?: Knex.Transaction): Promise<Row | null> {
    const query = (trx ?? this.read)(CREDIT_NOTES).where({ CreditNoteUID: creditNoteUID, OrgUID: orgUID, IsDeleted: 0 });
    if (excludeCancelled) query.where("IsCancelled", 0);
    return (await query.first()) ?? null;
  }

  // getPendingCreditNote / getAppliedCreditNote — the note in that status (applied: not cancelled)
  async creditNoteInStatus(orgUID: number, creditNoteUID: number, status: "Pending" | "Applied", trx?: Knex.Transaction): Promise<Row | null> {
    const query = (trx ?? this.read)(CREDIT_NOTES).select("CreditNoteUID", "CreditNoteNumber", "Amount", "PartyUID").where({ CreditNoteUID: creditNoteUID, OrgUID: orgUID, Status: status, IsDeleted: 0 });
    if (status === "Applied") query.where("IsCancelled", 0);
    return (await query.first()) ?? null;
  }

  // getCNAlreadyAppliedToTrans
  async creditNoteAppliedTo(orgUID: number, creditNoteUID: number, transUID: number, trx?: Knex.Transaction): Promise<boolean> {
    return !!(await (trx ?? this.read)(CREDIT_NOTES).select("CreditNoteUID").where({ CreditNoteUID: creditNoteUID, OrgUID: orgUID, AppliedTransUID: transUID, Status: "Applied", IsDeleted: 0 }).first());
  }

  // getPendingCreditNotes — the customer's usable notes with their source invoice number
  pendingCreditNotes(orgUID: number, customerUID: number): Promise<Row[]> {
    return this.read(`${CREDIT_NOTES} as CN`)
      .select("CN.*", "T.UniqueNumber as SourceInvoiceNumber")
      .leftJoin(`${TRANSACTIONS} as T`, "T.TransUID", "CN.SourceTransUID")
      .where({ "CN.OrgUID": orgUID, "CN.PartyUID": customerUID, "CN.PartyType": "C", "CN.Status": "Pending", "CN.IsCancelled": 0, "CN.IsDeleted": 0, "CN.IsActive": 1, "CN.PaymentCleared": 0 });
  }

  // getCreditNotesList — the Credit Notes tab
  async creditNotes(orgUID: number, limit: number, offset: number, status: string, search: string): Promise<{ total: number; rows: Row[] }> {
    const base = () => {
      const query = this.read(`${CREDIT_NOTES} as CN`).leftJoin("Customers.CustomerTbl as C", "C.CustomerUID", "CN.PartyUID").where({ "CN.OrgUID": orgUID, "CN.IsDeleted": 0, "CN.IsCancelled": 0 });
      if (status && status !== "All") query.where("CN.Status", status);
      if (search) this.whereAnyLike(query, ["CN.CreditNoteNumber", "C.Name", "CN.SourceTransNumber"], search);
      return query;
    };
    const counted = await base().count("* as total").first();
    const rows: Row[] = await base()
      .select(
        "CN.CreditNoteUID",
        "CN.CreditNoteNumber",
        "CN.CreditNoteToken",
        "CN.CreditNoteType",
        "CN.SourceTransUID",
        "CN.SourceTransNumber",
        "CN.SourceModuleUID",
        "CN.Amount",
        "CN.Status",
        "CN.Notes",
        "CN.CreatedOn",
        "C.CustomerUID",
        "C.Name as CustomerName",
        "C.MobileNumber as MobileNo",
        "C.Area as CustomerArea",
        "C.Image as CustomerImage",
        "T.TransDate as SourceTransDate",
        "T.TransToken as SourceTransToken",
        this.read.raw("CONCAT(U.FirstName, ' ', U.LastName) AS CreatorName")
      )
      .leftJoin(`${TRANSACTIONS} as T`, (on) => on.on("T.TransUID", "CN.SourceTransUID").andOnVal("T.IsDeleted", "=", 0))
      .leftJoin("Users.UserTbl as U", "U.UserUID", "CN.CreatedBy")
      .orderBy("CN.CreatedOn", "desc")
      .limit(limit)
      .offset(offset);
    return { total: Number(counted?.total ?? 0), rows: rows.map((row) => ({ ...row, CustomerImageUrl: resolveCdnUrl(row.CustomerImage as string) })) };
  }

  // Customer payments of an invoice not yet moved into a credit note (createCreditNote)
  async untransferredPaid(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<number> {
    const row = await trx(PAYMENTS)
      .sum("Amount as paid")
      .where({ TransUID: transUID, OrgUID: orgUID, PartyType: "C", PaymentDirection: "In", IsDeleted: 0, IsCancelled: 0, IsTransferredToCreditNote: 0 })
      .whereRaw(OWN)
      .first();
    return Number(row?.paid ?? 0);
  }

  async markTransferred(trx: Knex.Transaction, orgUID: number, transUID: number, userUID: number): Promise<void> {
    await trx(PAYMENTS)
      .where({ TransUID: transUID, OrgUID: orgUID, PartyType: "C", PaymentDirection: "In", IsDeleted: 0, IsCancelled: 0, IsTransferredToCreditNote: 0 })
      .whereRaw(OWN)
      .update({ IsTransferredToCreditNote: 1, UpdatedBy: userUID });
  }

  // refundCreditNote — the source invoice's payments that went into the note are voided
  async cancelTransferredPayments(trx: Knex.Transaction, orgUID: number, transUID: number, userUID: number): Promise<void> {
    await trx(PAYMENTS)
      .where({ TransUID: transUID, OrgUID: orgUID, PartyType: "C", PaymentDirection: "In", IsDeleted: 0, IsTransferredToCreditNote: 1 })
      .whereRaw(OWN)
      .update({ IsCancelled: 1, UpdatedBy: userUID });
  }

  // hasCNAppliedForSR
  async salesReturnCreditNoteApplied(orgUID: number, transUID: number): Promise<boolean> {
    return !!(await this.read(CREDIT_NOTES).select("CreditNoteUID").where({ SourceTransUID: transUID, SourceModuleUID: 106, OrgUID: orgUID, IsDeleted: 0, IsCancelled: 0, Status: "Applied" }).first());
  }

  // getPendingCNForSR
  async salesReturnPendingCreditNote(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<Row | null> {
    return (await trx(CREDIT_NOTES).where({ SourceTransUID: transUID, SourceModuleUID: 106, OrgUID: orgUID, Status: "Pending", IsCancelled: 0, IsDeleted: 0 }).first()) ?? null;
  }

  // The Pending credit note a sales return raised for itself is cancelled / deleted with it
  async retireSalesReturnCreditNotes(trx: Knex.Transaction, orgUID: number, transUID: number, mode: "cancel" | "delete", userUID: number): Promise<void> {
    await trx(CREDIT_NOTES)
      .where({ SourceTransUID: transUID, SourceModuleUID: 106, OrgUID: orgUID, Status: "Pending", IsCancelled: 0, IsDeleted: 0 })
      .update(mode === "cancel" ? { IsCancelled: 1, UpdatedBy: userUID } : { IsDeleted: 1, UpdatedBy: userUID });
  }
}
